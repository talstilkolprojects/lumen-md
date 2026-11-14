/**
 * Notes that arrive as web pages: Apple Notes exports (a folder of
 * `.html` / `.txt` / `.md`, images beside them or inline as `data:` URIs),
 * OneNote pages and sections saved as a single web page (`.mht`, File →
 * Export → Single File Web Page) or as `.htm` with a `_files` folder.
 * Each page becomes a note in the same folder; its images and attachments
 * become files next to it; links between the pages follow them.
 */
import { claimPath, dirOf, mdDest, mdEmbed, relativeTo, resolveRel, safeName, safePath, stemOf } from "./names";
import { dataUri, decodeEntities, htmlToNote } from "./html";
import { isoDate, withFrontmatter } from "./frontmatter";
import { emptyVault, type ConvertedVault, type ImportSourceId } from "./types";

/* ─── MHTML ──────────────────────────────────────────────────────────── */

export interface MimePart {
  type: string;
  charset: string;
  location: string;
  data: Uint8Array;
}

function qpBytes(s: string): Uint8Array {
  const clean = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "=" && /^[0-9A-F]{2}$/i.test(clean.slice(i + 1, i + 3))) {
      out.push(parseInt(clean.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...new TextEncoder().encode(c));
  }
  return Uint8Array.from(out);
}

function headerMap(block: string): Map<string, string> {
  const h = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return h;
}

/** The parts of a MIME multipart file (`.mht`, `.mhtml`), each decoded to bytes. */
export function parseMhtml(text: string): MimePart[] {
  const head = text.split(/\r?\n\r?\n/)[0] ?? "";
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1] ?? /boundary="?([^";\r\n]+)"?/i.exec(text)?.[1];
  const parts: MimePart[] = [];
  const chunks = boundary ? text.split(`--${boundary}`).slice(1) : [text];
  for (const chunk of chunks) {
    if (chunk.startsWith("--")) break;
    const cut = chunk.search(/\r?\n\r?\n/);
    if (cut < 0) continue;
    const h = headerMap(chunk.slice(0, cut));
    const body = chunk.slice(cut).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    const ctype = h.get("content-type") ?? "text/html";
    const enc = (h.get("content-transfer-encoding") ?? "").toLowerCase();
    let data: Uint8Array;
    try {
      data = enc === "base64" ? Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0)) : enc === "quoted-printable" ? qpBytes(body) : new TextEncoder().encode(body);
    } catch {
      continue;
    }
    parts.push({
      type: ctype.split(";")[0].trim().toLowerCase(),
      charset: /charset="?([^";]+)"?/i.exec(ctype)?.[1]?.toLowerCase() ?? "utf-8",
      location: h.get("content-location") ?? "",
      data,
    });
  }
  return parts;
}

function decodeText(data: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(data);
  } catch {
    return new TextDecoder().decode(data);
  }
}

/* ─── Web pages → notes ──────────────────────────────────────────────── */

interface Page {
  src: string;
  html: string;
  /** Resources of a `.mht`, by their Content-Location. */
  inline?: Map<string, Uint8Array>;
  note: string;
  title: string;
}

const metaDate = (html: string, names: string[]): string | undefined => {
  for (const n of names) {
    const m = new RegExp(`<meta\\s+(?:name|property)="${n}"\\s+content="([^"]+)"`, "i").exec(html) ?? new RegExp(`<meta\\s+content="([^"]+)"\\s+(?:name|property)="${n}"`, "i").exec(html);
    if (m) {
      const d = isoDate(new Date(m[1]));
      if (d) return d;
    }
  }
  return undefined;
};

export function convertHtmlNotes(files: Map<string, Uint8Array>, source: ImportSourceId): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const dec = new TextDecoder();
  const pages: Page[] = [];
  const noteOf = new Map<string, string>();
  const used = new Set<string>();
  // An image two pages show is copied once.
  const placedFile = new Map<string, string>();
  for (const [p, data] of files) {
    if (/(^|\/)(\.DS_Store|desktop\.ini|Thumbs\.db)$/i.test(p)) {
      vault.skipped.push({ path: p, reason: "appFolder" });
    } else if (/\.(mht|mhtml)$/i.test(p)) {
      const parts = parseMhtml(dec.decode(data));
      const html = parts.find((x) => x.type === "text/html");
      if (!html) {
        vault.skipped.push({ path: p, reason: "unreadable" });
        continue;
      }
      const inline = new Map<string, Uint8Array>();
      for (const part of parts) {
        if (part === html || !part.location) continue;
        inline.set(part.location, part.data);
        vault.sourceAttachments++;
      }
      pages.push({ src: p, html: decodeText(html.data, html.charset), inline, note: "", title: "" });
    } else if (/\.(html?|xhtml)$/i.test(p)) {
      pages.push({ src: p, html: dec.decode(data), note: "", title: "" });
    } else if (/\.(md|markdown|txt)$/i.test(p)) {
      const text = dec.decode(data);
      const notePath = claimPath(taken, safePath(p.replace(/\.(markdown|txt)$/i, ".md")));
      noteOf.set(p, notePath);
      vault.notes.set(notePath, text);
    } else if (/\.one(pkg)?$/i.test(p)) {
      vault.skipped.push({ path: p, reason: "unsupported", detail: ".mht" });
    }
  }
  for (const page of pages) {
    const title = decodeEntities(/<title>([\s\S]*?)<\/title>/i.exec(page.html)?.[1] ?? "").trim() || stemOf(page.src);
    const notePath = claimPath(taken, `${dirOf(safePath(page.src)) ? `${dirOf(safePath(page.src))}/` : ""}${safeName(stemOf(page.src) || title)}.md`);
    noteOf.set(page.src, notePath);
    page.note = notePath;
    page.title = title;
  }
  for (const page of pages) {
    const fromDir = dirOf(page.note);
    const attachDir = `${fromDir ? `${fromDir}/` : ""}attachments`;
    const place = (name: string, data: Uint8Array) => {
      const target = claimPath(taken, `${attachDir}/${safePath(name)}`);
      vault.attachments.set(target, data);
      return target;
    };
    let n = 0;
    const placed = new Map<string, string>();
    const fromInline = (src: string): string | null => {
      if (!page.inline) return null;
      const base = src.split(/[\\/]/).pop() ?? src;
      for (const [loc, data] of page.inline) {
        if (loc !== src && !loc.endsWith(`/${src}`) && (loc.split(/[\\/]/).pop() ?? "") !== base) continue;
        if (!placed.has(loc)) placed.set(loc, place(base, data));
        return placed.get(loc)!;
      }
      return null;
    };
    const body = htmlToNote(page.html, {
      image: (src, alt) => {
        const inline = dataUri(src);
        if (inline) {
          vault.sourceAttachments++;
          return mdEmbed(place(`${safeName(stemOf(page.note))}-${++n}${inline.ext}`, inline.data), fromDir, alt || undefined);
        }
        const fromMht = fromInline(src);
        if (fromMht) return mdEmbed(fromMht, fromDir, alt || undefined);
        let rel = src;
        try {
          rel = decodeURIComponent(src);
        } catch {
          /* as written */
        }
        const file = resolveRel(dirOf(page.src), rel);
        const data = files.get(file);
        if (!data) {
          if (!/^[a-z]+:/i.test(src)) vault.warnings.push({ path: page.note, reason: "missingAttachment", detail: src });
          return null;
        }
        used.add(file);
        if (!placedFile.has(file)) placedFile.set(file, place(file.split("/").pop() ?? file, data));
        return mdEmbed(placedFile.get(file)!, fromDir, alt || undefined);
      },
      link: (href, text) => {
        if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return null;
        let rel = href.split("#")[0];
        try {
          rel = decodeURIComponent(rel);
        } catch {
          /* as written */
        }
        const file = resolveRel(dirOf(page.src), rel);
        const note = noteOf.get(file);
        if (note) return `[${text.replace(/[[\]]/g, "") || stemOf(note)}](${mdDest(relativeTo(fromDir, note))})`;
        const data = files.get(file);
        if (!data) return null;
        used.add(file);
        if (!placedFile.has(file)) placedFile.set(file, place(file.split("/").pop() ?? file, data));
        return `[${text.replace(/[[\]]/g, "") || stemOf(file)}](${mdDest(relativeTo(fromDir, placedFile.get(file)!))})`;
      },
    });
    // Unused parts of a .mht (OneNote's attached files) stay with the note.
    const extra: string[] = [];
    for (const [loc, data] of page.inline ?? []) {
      if (placed.has(loc)) continue;
      extra.push(mdEmbed(place(loc.split(/[\\/]/).pop() || "attachment", data), fromDir));
    }
    const created = metaDate(page.html, ["created", "dcterms.created", "article:published_time"]);
    const updated = metaDate(page.html, ["modified", "dcterms.modified", "last-modified", "article:modified_time"]);
    if (!created && !updated) vault.warnings.push({ path: page.note, reason: "noDates" });
    const heading = /^#\s/.test(body.trimStart()) ? "" : `# ${page.title}\n\n`;
    vault.notes.set(page.note, withFrontmatter({ created, updated, source: source === "onenote" ? "OneNote" : source === "appleNotes" ? "Apple Notes" : undefined }, `${heading}${body.trim()}${extra.length ? `\n\n${extra.join("\n")}` : ""}\n`));
  }
  // Images and files next to the pages that no page shows: kept, never dropped.
  for (const [p, data] of files) {
    if (/\.(mht|mhtml|html?|xhtml|md|markdown|txt|one|onepkg)$/i.test(p) || /(^|\/)(\.DS_Store|desktop\.ini|Thumbs\.db)$/i.test(p)) continue;
    vault.sourceAttachments++;
    if (used.has(p)) continue;
    vault.attachments.set(claimPath(taken, safePath(p)), data);
  }
  return vault;
}
