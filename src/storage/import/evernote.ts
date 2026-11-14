/**
 * Evernote: `.enex` files (File → Export notes → ENEX). One notebook per
 * file; each `<note>` has its title, ENML content, dates, tags and
 * `<resource>`s (base64 attachments, referred to in the content by the MD5
 * of their data). A notebook becomes a folder, a note a Markdown file
 * with its dates and tags as properties, its attachments go to
 * `_resources/<note>/`.
 */
import { claimPath, mdEmbed, safeName, stemOf } from "./names";
import { decodeEntities, base64Bytes, extFromMime, htmlToNote } from "./html";
import { isoDate, tagValue, withFrontmatter } from "./frontmatter";
import { md5Hex } from "./md5";
import { emptyVault, type ConvertedVault } from "./types";

/** `20240131T101500Z` → ISO. */
export function enexDate(s: string | undefined): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s?.trim() ?? "");
  return m ? isoDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))) : undefined;
}

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : undefined;
};
const tags = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);

interface Resource {
  hash: string;
  data: Uint8Array;
  mime: string;
  name: string;
  path?: string;
  used: boolean;
}

export function convertEvernote(files: Map<string, Uint8Array>): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const dec = new TextDecoder();
  // Note links (`evernote:///view/…`, or the web link) name no file: they go by the note's title.
  const titles = new Set<string>();
  for (const [file, bytes] of files) if (/\.enex$/i.test(file)) for (const m of dec.decode(bytes).matchAll(/<note>[\s\S]*?<title>([\s\S]*?)<\/title>/g)) titles.add(decodeEntities(m[1]).trim());
  for (const [file, bytes] of files) {
    if (!/\.enex$/i.test(file)) {
      vault.skipped.push({ path: file, reason: "unsupported", detail: ".enex" });
      continue;
    }
    const xml = dec.decode(bytes);
    if (!/<en-export[\s>]/.test(xml)) {
      vault.skipped.push({ path: file, reason: "unreadable" });
      continue;
    }
    const notebook = safeName(stemOf(file), "Evernote");
    for (const nm of xml.matchAll(/<note>([\s\S]*?)<\/note>/g)) {
      const note = nm[1];
      const title = tag(note, "title") || "Untitled";
      const notePath = claimPath(taken, `${notebook}/${safeName(title)}.md`);
      const noteStem = stemOf(notePath);
      const resources: Resource[] = [];
      for (const rm of note.matchAll(/<resource>([\s\S]*?)<\/resource>/g)) {
        const r = rm[1];
        const raw = /<data(?:\s[^>]*)?>([\s\S]*?)<\/data>/.exec(r)?.[1] ?? "";
        let data: Uint8Array;
        try {
          data = base64Bytes(raw);
        } catch {
          vault.warnings.push({ path: notePath, reason: "missingAttachment", detail: tag(r, "file-name") ?? "" });
          continue;
        }
        vault.sourceAttachments++;
        const mime = tag(r, "mime") ?? "application/octet-stream";
        const fileName = tag(r, "file-name");
        resources.push({ hash: md5Hex(data), data, mime, name: fileName ? safeName(fileName) : `attachment${extFromMime(mime)}`, used: false });
      }
      const place = (r: Resource): string => {
        if (!r.path) {
          const ext = /\.[A-Za-z0-9]{1,10}$/.test(r.name) ? "" : extFromMime(r.mime);
          r.path = claimPath(taken, `${notebook}/_resources/${noteStem}/${r.name}${ext}`);
          vault.attachments.set(r.path, r.data);
        }
        return r.path;
      };
      const content = /<content>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/content>/.exec(note)?.[1] ?? "";
      const encrypted = /<en-crypt[\s>]/.test(content);
      // ENML → HTML the converter knows: media become <img>/<a> with a
      // marker the image/link hooks below turn into the attachment's path.
      const html = content
        .replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/gi, "")
        // ENML writes each line as a <div>: paragraphs, so lines stay lines.
        .replace(/<div(\s[^>]*)?>/gi, "<p>")
        .replace(/<\/div>/gi, "</p>")
        .replace(/<en-crypt[\s\S]*?<\/en-crypt>/gi, "")
        .replace(/<en-todo\s+checked="true"\s*\/?>(?:<\/en-todo>)?/gi, '<input type="checkbox" checked>')
        .replace(/<en-todo[^>]*\/?>(?:<\/en-todo>)?/gi, '<input type="checkbox">')
        .replace(/<en-media\s([^>]*?)\/?>(?:<\/en-media>)?/gi, (_, attrs: string) => {
          const hash = /hash="([0-9a-f]+)"/i.exec(attrs)?.[1]?.toLowerCase() ?? "";
          return `<img src="enex-media:${hash}" alt="">`;
        });
      let body = htmlToNote(html, {
        image: (src) => {
          if (!src.startsWith("enex-media:")) return null;
          const r = resources.find((x) => x.hash === src.slice("enex-media:".length));
          if (!r) {
            vault.warnings.push({ path: notePath, reason: "missingAttachment", detail: src.slice("enex-media:".length) });
            return "";
          }
          r.used = true;
          return mdEmbed(place(r), notebook);
        },
        link: (href, text) => {
          if (!/^evernote:|^https:\/\/(www\.)?evernote\.com\/(shard|l)\//i.test(href) || !titles.has(text)) return null;
          const name = safeName(text);
          return name === text ? `[[${name}]]` : `[[${name}|${text.replace(/[[\]|]/g, "")}]]`;
        },
      });
      // An attachment the content never shows is still the note's: listed at its end, never dropped.
      const unused = resources.filter((r) => !r.used);
      if (unused.length) body += `\n\n${unused.map((r) => mdEmbed(place(r), notebook)).join("\n")}`;
      if (encrypted) vault.warnings.push({ path: notePath, reason: "encryptedPart" });
      const props = {
        created: enexDate(tag(note, "created")),
        updated: enexDate(tag(note, "updated")),
        tags: tags(note, "tag").map(tagValue),
        source: tag(note, "source-url"),
        author: tag(note, "author"),
      };
      if (!props.created && !props.updated) vault.warnings.push({ path: notePath, reason: "noDates" });
      vault.notes.set(notePath, withFrontmatter(props, `# ${title}\n\n${body.trim()}\n`));
    }
  }
  return vault;
}
