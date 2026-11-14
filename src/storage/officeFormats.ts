/**
 * Office and ebook formats (ZIP of XML) → Markdown (split out of fileFormats.ts,
 * plan W4.11): DOCX, ODT, PPTX, XLSX, EPUB and web-archive ZIPs, unzipped by the
 * native DecompressionStream reader in ./zip. fileFormats.ts re-exports them.
 */
import { unzip, unzipText } from "./zip";
import { parseInertDocument } from "../lib/trustedTypes";
import { htmlToMarkdown, csvToMarkdown } from "./markupFormats";

/* ─── DOCX → Markdown (real: unzip word/document.xml) ─────────────── */

const els = (parent: Element | Document, tag: string) =>
  Array.from(parent.getElementsByTagName(tag));

/**
 * Real DOCX import: unzips the package and walks `word/document.xml`.
 * Headings (Heading1–6 / Title styles), bold / italic runs (the complex-
 * script `w:bCs` / `w:iCs` too: Word and LibreOffice mark Hebrew bold that
 * way), lists from `word/numbering.xml` (bullet or numbered, nested by
 * `w:ilvl`), hyperlinks from the relationships, tables, and images, which
 * come along inline as `data:` URIs (up to 512 KB each; a larger one keeps
 * its alt text and file name). Plan W6.38 measured this on a real corpus.
 */
export async function docxToMarkdown(file: File): Promise<string> {
  let parts: Map<string, Uint8Array>;
  try {
    parts = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read DOCX archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const part = (name: string) => {
    const b = parts.get(name);
    return b ? dec.decode(b) : null;
  };
  const xml = part("word/document.xml");
  if (!xml) return "> ⚠️ DOCX has no word/document.xml part.";

  const doc = parseInertDocument(xml, "application/xml");
  const body = doc.getElementsByTagName("w:body")[0];
  if (!body) return "> ⚠️ DOCX document body not found.";

  // Relationships: hyperlink targets and image parts.
  const rels = new Map<string, string>();
  const relsXml = part("word/_rels/document.xml.rels");
  if (relsXml) for (const r of els(parseInertDocument(relsXml, "application/xml"), "Relationship")) rels.set(r.getAttribute("Id") ?? "", r.getAttribute("Target") ?? "");

  // Numbering: numId → abstractNumId → per level, bullet or not.
  const bulletOf = new Map<string, boolean[]>();
  const numXml = part("word/numbering.xml");
  if (numXml) {
    const nd = parseInertDocument(numXml, "application/xml");
    const abstract = new Map<string, boolean[]>();
    for (const an of els(nd, "w:abstractNum")) {
      const levels: boolean[] = [];
      for (const lvl of els(an, "w:lvl")) levels[+(lvl.getAttribute("w:ilvl") ?? "0")] = lvl.getElementsByTagName("w:numFmt")[0]?.getAttribute("w:val") === "bullet";
      abstract.set(an.getAttribute("w:abstractNumId") ?? "", levels);
    }
    for (const n of els(nd, "w:num")) bulletOf.set(n.getAttribute("w:numId") ?? "", abstract.get(n.getElementsByTagName("w:abstractNumId")[0]?.getAttribute("w:val") ?? "") ?? []);
  }

  const on = (rPr: Element | undefined, ...tags: string[]) =>
    !!rPr && tags.some((t) => {
      const el = rPr.getElementsByTagName(t)[0];
      const v = el?.getAttribute("w:val");
      return !!el && v !== "0" && v !== "false";
    });

  const imageMd = (drawing: Element): string => {
    const props = drawing.getElementsByTagName("wp:docPr")[0];
    const alt = (props?.getAttribute("descr") || props?.getAttribute("title") || "").replace(/[[\]]/g, "");
    const id = drawing.getElementsByTagName("a:blip")[0]?.getAttribute("r:embed") ?? "";
    const target = rels.get(id) ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `word/${target}`;
    const data = parts.get(path);
    const ext = (/\.(\w+)$/.exec(target)?.[1] ?? "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
    if (!data || data.length > 512 * 1024) return `![${alt || target.split("/").pop()}](${target.split("/").pop() ?? ""})`;
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return `![${alt}](data:${mime};base64,${btoa(bin)})`;
  };

  // Runs of a paragraph (hyperlinks included), with neighbouring runs of the same emphasis joined.
  const paraText = (p: Element): string => {
    const pieces: { text: string; b: boolean; i: boolean; href?: string; raw?: boolean }[] = [];
    const runOf = (r: Element, href?: string) => {
      for (const d of els(r, "w:drawing")) pieces.push({ text: imageMd(d), b: false, i: false, raw: true });
      let t = "";
      for (const c of Array.from(r.children)) {
        if (c.tagName === "w:t") t += c.textContent ?? "";
        else if (c.tagName === "w:tab") t += "\t";
        else if (c.tagName === "w:br") t += " ";
      }
      if (!t) return;
      const rPr = r.getElementsByTagName("w:rPr")[0];
      pieces.push({ text: t, b: on(rPr, "w:b", "w:bCs"), i: on(rPr, "w:i", "w:iCs"), href });
    };
    for (const c of Array.from(p.children)) {
      if (c.tagName === "w:r") runOf(c);
      else if (c.tagName === "w:hyperlink") {
        const href = rels.get(c.getAttribute("r:id") ?? ""); // an internal w:anchor link keeps its text only
        for (const r of els(c, "w:r")) runOf(r, href);
      } else if (c.tagName === "w:ins" || c.tagName === "w:smartTag" || c.tagName === "w:sdt") for (const r of els(c, "w:r")) runOf(r);
    }
    // Whitespace takes the emphasis of the text before it, so "**a** **b**" joins into one span.
    for (let k = 1; k < pieces.length; k++) if (!pieces[k].raw && !pieces[k].text.trim()) Object.assign(pieces[k], { b: pieces[k - 1].b, i: pieces[k - 1].i });
    const groups: typeof pieces = [];
    for (const x of pieces) {
      const last = groups[groups.length - 1];
      if (last && !last.raw && !x.raw && last.b === x.b && last.i === x.i && last.href === x.href) last.text += x.text;
      else groups.push({ ...x });
    }
    return groups
      .map((g) => {
        if (g.raw) return g.text;
        const lead = /^\s*/.exec(g.text)![0];
        const trail = /\s*$/.exec(g.text)![0];
        let core = g.text.trim();
        if (!core) return g.text;
        if (g.b) core = `**${core}**`;
        if (g.i) core = `*${core}*`;
        if (g.href) core = `[${core}](${g.href})`;
        return lead + core + trail;
      })
      .join("")
      .trim();
  };

  const listOf = (p: Element): { depth: number; bullet: boolean } | null => {
    const numPr = p.getElementsByTagName("w:numPr")[0];
    if (!numPr) return null;
    const numId = numPr.getElementsByTagName("w:numId")[0]?.getAttribute("w:val") ?? "";
    if (numId === "0") return null;
    const depth = +(numPr.getElementsByTagName("w:ilvl")[0]?.getAttribute("w:val") ?? "0");
    return { depth, bullet: bulletOf.get(numId)?.[depth] ?? true };
  };

  const out: string[] = [];
  let inList = false;
  for (const node of Array.from(body.children)) {
    if (node.tagName === "w:p") {
      const text = paraText(node);
      if (!text) continue;
      const style = node.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val")?.toLowerCase();
      const heading = style?.match(/heading(\d)/);
      const list = heading ? null : listOf(node);
      let md: string;
      if (heading) md = `${"#".repeat(Math.min(6, +heading[1]))} ${text}`;
      else if (style === "title") md = `# ${text}`;
      else if (list) md = `${"   ".repeat(list.depth)}${list.bullet ? "-" : "1."} ${text}`;
      else md = text;
      // A list's items stay together; anything else is its own block.
      if (list && inList) out[out.length - 1] += `\n${md}`;
      else out.push(md);
      inList = !!list;
    } else if (node.tagName === "w:tbl") {
      out.push(docxTableToMd(node));
      inList = false;
    }
  }
  const md = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return md || "> ⚠️ DOCX contained no extractable text.";
}

function docxTableToMd(tbl: Element): string {
  const rows = els(tbl, "w:tr");
  if (!rows.length) return "";
  const cellText = (tc: Element) =>
    els(tc, "w:p")
      .map((p) => els(p, "w:t").map((t) => t.textContent ?? "").join(""))
      .join(" ")
      .trim();
  const matrix = rows.map((tr) => els(tr, "w:tc").map(cellText));
  const cols = Math.max(...matrix.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill("")];
  const header = pad(matrix[0]);
  const sep = header.map(() => "---");
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + sep.join(" | ") + " |",
    ...matrix.slice(1).map((r) => "| " + pad(r).join(" | ") + " |"),
  ];
  return lines.join("\n");
}

/* ─── ODT → Markdown (real: unzip content.xml) ────────────────────── */

/**
 * Real ODT import: unzips `content.xml` and walks the OpenDocument text tree.
 * Handles headings (by outline level) and paragraphs, including list items.
 * Inline bold/italic in ODT lives in indirected automatic-styles, so it is
 * not resolved here — text is preserved, emphasis is not.
 */
export async function odtToMarkdown(file: File): Promise<string> {
  let xml: string | null;
  try {
    xml = await unzipText(await file.arrayBuffer(), "content.xml");
  } catch (err) {
    return `> ⚠️ Could not read ODT archive: ${(err as Error).message}`;
  }
  if (!xml) return "> ⚠️ ODT has no content.xml part.";

  const doc = parseInertDocument(xml, "application/xml");
  const out: string[] = [];
  const walk = (parent: Element, inList: boolean) => {
    for (const node of Array.from(parent.children)) {
      const tag = node.tagName;
      if (tag === "text:h") {
        const level = Math.min(6, +(node.getAttribute("text:outline-level") || "1"));
        const text = (node.textContent ?? "").trim();
        if (text) out.push(`${"#".repeat(level)} ${text}`);
      } else if (tag === "text:p") {
        const text = (node.textContent ?? "").trim();
        if (text) out.push(inList ? `- ${text}` : text);
      } else if (tag === "text:list") {
        walk(node, true);
      } else {
        walk(node, inList);
      }
    }
  };
  const bodyText = doc.getElementsByTagName("office:text")[0];
  if (bodyText) walk(bodyText, false);
  const md = out.join("\n\n").trim();
  return md || "> ⚠️ ODT contained no extractable text.";
}

/* ─── PPTX → Markdown (real: unzip ppt/slides/*.xml) ──────────────── */

const slideNum = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

/**
 * Real PPTX import: unzips the deck and converts each slide (in slide-number
 * order) into a `## ` heading (first text line) plus bullets for the rest.
 * Speaker notes and images are not extracted.
 */
export async function pptxToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read PPTX archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const slides = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
  if (!slides.length) return "> ⚠️ PPTX: no slides found.";

  const out: string[] = [];
  slides.forEach((name, i) => {
    const doc = parseInertDocument(dec.decode(files.get(name)!), "application/xml");
    const paras = els(doc, "a:p")
      .map((p) => els(p, "a:t").map((t) => t.textContent ?? "").join("").trim())
      .filter(Boolean);
    out.push(`## ${paras[0] ?? `Slide ${i + 1}`}`);
    for (const line of paras.slice(1)) out.push(`- ${line}`);
  });
  return out.join("\n\n");
}

/* ─── XLSX → Markdown tables (real: unzip xl/worksheets/*.xml) ─────── */

/** Convert a cell reference like "B7" to a 0-based column index. */
function colToIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

/**
 * Real XLSX import: unzips the workbook, resolves shared strings, and renders
 * each worksheet as a Markdown table under a `## SheetName` heading. Formulas
 * render as their cached value; styles/merged cells are not preserved.
 */
export async function xlsxToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read XLSX archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const parse = (name: string) =>
    files.has(name)
      ? parseInertDocument(dec.decode(files.get(name)!), "application/xml")
      : null;

  const shared: string[] = [];
  const ss = parse("xl/sharedStrings.xml");
  if (ss) for (const si of els(ss, "si")) shared.push(els(si, "t").map((t) => t.textContent ?? "").join(""));

  const names: string[] = [];
  const wb = parse("xl/workbook.xml");
  if (wb) for (const s of els(wb, "sheet")) names.push(s.getAttribute("name") ?? "");

  const sheets = [...files.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
  if (!sheets.length) return "> ⚠️ XLSX: no worksheets found.";

  const out: string[] = [];
  sheets.forEach((name, si) => {
    const doc = parse(name)!;
    const matrix: string[][] = [];
    for (const row of els(doc, "row")) {
      const arr: string[] = [];
      for (const c of els(row, "c")) {
        const idx = colToIndex(c.getAttribute("r") ?? "A");
        const type = c.getAttribute("t");
        const raw = els(c, "v")[0]?.textContent ?? "";
        arr[idx] =
          type === "s"
            ? shared[Number(raw)] ?? ""
            : type === "inlineStr"
              ? els(c, "t").map((t) => t.textContent ?? "").join("")
              : raw;
      }
      for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = "";
      matrix.push(arr);
    }
    if (!matrix.length) return;
    const cols = Math.max(...matrix.map((r) => r.length));
    const pad = (r: string[]) => {
      const c = [...r];
      while (c.length < cols) c.push("");
      return c;
    };
    const header = pad(matrix[0]);
    out.push(
      [
        `## ${names[si] || `Sheet ${si + 1}`}`,
        "",
        "| " + header.join(" | ") + " |",
        "| " + header.map(() => "---").join(" | ") + " |",
        ...matrix.slice(1).map((r) => "| " + pad(r).join(" | ") + " |"),
      ].join("\n"),
    );
  });
  return out.join("\n\n") || "> ⚠️ XLSX contained no data.";
}

/* ─── Notion / Obsidian archive → merged Markdown ─────────────────── */

/** Strip Notion's 32-hex-char id suffix and folder path from an entry name. */
function cleanArchiveTitle(name: string): string {
  return (
    name
      .replace(/\.md$/i, "")
      .split("/")
      .pop() ?? name
  )
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .trim();
}

/**
 * Import a Notion export or Obsidian vault (both shipped as a .zip of Markdown
 * files, possibly with CSV databases). Each .md file becomes a section (a
 * leading H1 is added from the cleaned filename if the file lacks one); CSV
 * files render as tables. Obsidian `[[wikilinks]]` pass through unchanged —
 * Lumen renders them natively. Notion's "Title <hash>" names are cleaned up.
 */
export async function archiveToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const mdFiles = [...files.keys()].filter((n) => /\.md$/i.test(n) && !n.startsWith("__MACOSX")).sort();
  const csvFiles = [...files.keys()].filter((n) => /\.csv$/i.test(n) && !n.startsWith("__MACOSX")).sort();
  if (!mdFiles.length && !csvFiles.length) {
    return "> ⚠️ Archive contains no Markdown or CSV files.";
  }

  const parts: string[] = [];
  for (const name of mdFiles) {
    const body = dec.decode(files.get(name)!).trim();
    const hasLeadingH1 = /^#\s+/.test(body);
    parts.push(hasLeadingH1 ? body : `# ${cleanArchiveTitle(name)}\n\n${body}`);
  }
  for (const name of csvFiles) {
    parts.push(`## ${cleanArchiveTitle(name)}\n\n${csvToMarkdown(dec.decode(files.get(name)!))}`);
  }
  return parts.join("\n\n---\n\n");
}

/* ─── EPUB → Markdown (zero-dep regex over packaged XHTML) ────────── */

/**
 * Real EPUB import: unzips the archive, reads META-INF/container.xml to find
 * the OPF package, then converts each spine document (in reading order) from
 * XHTML to Markdown. Falls back to converting every (x)html entry if the OPF
 * structure can't be read.
 */
export async function epubToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read EPUB archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const textOf = (name: string) => {
    const b = files.get(name);
    return b ? dec.decode(b) : null;
  };
  const htmlToChapter = (html: string) => {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return htmlToMarkdown(`<div>${bodyMatch ? bodyMatch[1] : html}</div>`).trim();
  };

  // Resolve the spine order via container.xml → OPF.
  const container = textOf("META-INF/container.xml");
  const opfPath = container?.match(/full-path="([^"]+)"/i)?.[1];
  const opf = opfPath ? textOf(opfPath) : null;

  const chapters: string[] = [];
  if (opf && opfPath) {
    const opfDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]+$/, "/") : "";
    const doc = parseInertDocument(opf, "application/xml");
    const manifest = new Map<string, string>();
    for (const item of els(doc, "item")) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (id && href) manifest.set(id, href);
    }
    for (const ref of els(doc, "itemref")) {
      const href = manifest.get(ref.getAttribute("idref") ?? "");
      if (!href) continue;
      const html = textOf(decodeURIComponent(opfDir + href));
      if (html) {
        const md = htmlToChapter(html);
        if (md) chapters.push(md);
      }
    }
  }

  // Fallback: every (x)html entry, in archive order.
  if (chapters.length === 0) {
    for (const [name, bytes] of files) {
      if (/\.x?html?$/i.test(name)) {
        const md = htmlToChapter(dec.decode(bytes));
        if (md.length > 30) chapters.push(md);
      }
    }
  }

  return chapters.length
    ? chapters.join("\n\n---\n\n")
    : "> ⚠️ EPUB: no readable chapters found.";
}
