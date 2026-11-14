/**
 * Logseq: the graph folder (pages/, journals/, assets/, logseq/). Page
 * properties (`key:: value` before the first block) become frontmatter,
 * block ids (`id:: <uuid>`) become `^block` ids, block references
 * `((uuid))` and `{{embed …}}` become `[[Page#^id]]` / `![[…]]`, TODO /
 * DONE markers become tasks, journal files get ISO names (2024-01-31) and
 * the links to them follow, namespaced pages (`a___b.md`, `a%2Fb.md`)
 * become folders.
 */
import { claimPath, dirOf, mdDest, relativeTo, resolveRel, safeName, stemOf } from "./names";
import { withFrontmatter } from "./frontmatter";
import { emptyVault, type ConvertedVault } from "./types";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Logseq's default journal title (`Jan 31st, 2024`), and `2024_01_31` / `2024-01-31`, → `2024-01-31`. */
export function journalDate(title: string): string | null {
  const s = title.trim();
  let m = /^(\d{4})[_-](\d{2})[_-](\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?, (\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

/** A page file's name → the page's path: `a___b` and `a%2Fb` (and `a.b` in old graphs, never) → `a/b`. */
export function pageName(fileStem: string): string {
  let s = fileStem;
  try {
    s = decodeURIComponent(s.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    // why: not percent-encoded: the file name is the page name
    /* as written */
  }
  return s.replace(/___/g, "/");
}

const PROP = /^([A-Za-z0-9_\-\u{0590}-\u{05ff}]+):: ?(.*)$/u;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface Page {
  src: string;
  name: string;
  path: string;
  text: string;
}

function propValue(v: string): unknown {
  const s = v.trim();
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const links = [...s.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  if (links.length && s.replace(/\[\[[^\]]+\]\]|[,\s]/g, "") === "") return links;
  return s;
}

export function convertLogseq(files: Map<string, Uint8Array>): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const dec = new TextDecoder();
  const pages: Page[] = [];
  const byName = new Map<string, Page>();
  for (const [p, data] of files) {
    if (/(^|\/)(logseq|\.recycle|\.git)\//.test(p) || /(^|\/)\.DS_Store$/.test(p)) {
      vault.skipped.push({ path: p, reason: p.includes(".recycle/") ? "trashed" : "appFolder" });
      continue;
    }
    if (/\.(md|markdown)$/i.test(p)) {
      const text = dec.decode(data);
      const journal = /(^|\/)journals\//.test(p);
      const titleProp = /^title:: (.+)$/m.exec(text.split(/\n\s*-\s/)[0] ?? "")?.[1]?.trim();
      const stem = stemOf(p);
      const date = journal ? journalDate(stem) : null;
      const name = date ?? titleProp ?? pageName(stem);
      const folder = journal ? "journals" : "pages";
      const path = claimPath(taken, `${folder}/${name.split("/").map((s) => safeName(s)).join("/")}.md`);
      const page = { src: p, name, path, text };
      pages.push(page);
      byName.set(name.toLowerCase(), page);
    } else if (/\.(org)$/i.test(p)) {
      vault.skipped.push({ path: p, reason: "unsupported", detail: ".org" });
    } else {
      vault.sourceAttachments++;
      vault.attachments.set(claimPath(taken, p.normalize("NFC")), data);
    }
  }
  const find = (target: string) => byName.get(target.toLowerCase()) ?? byName.get(journalDate(target) ?? "\0");
  const assetPaths = new Map([...vault.attachments.keys()].map((k) => [k.toLowerCase(), k]));
  // Block ids: which page holds each uuid.
  const blockPage = new Map<string, Page>();
  for (const page of pages) for (const m of page.text.matchAll(/^\s*id:: (\S+)\s*$/gm)) if (UUID.test(m[1])) blockPage.set(m[1].toLowerCase(), page);
  // A wikilink names a page by its path below pages/ or journals/ (`a/b`,
  // `2024-01-31`), which resolves as a path suffix wherever the import lands.
  const linkTo = (target: string): string => {
    const page = find(target);
    return page ? page.path.replace(/^(pages|journals)\//, "").replace(/\.md$/, "") : target;
  };
  for (const page of pages) {
    const lines = page.text.replace(/\r\n/g, "\n").split("\n");
    const props: Record<string, unknown> = {};
    // Page properties: the `key:: value` lines before the first block (or
    // in a first block that holds nothing else: `- title:: x`).
    let i = 0;
    let first = true;
    while (i < lines.length) {
      if (!lines[i].trim()) {
        i++;
        continue;
      }
      const m = PROP.exec(first ? lines[i].replace(/^-\s+/, "") : lines[i].replace(/^\s+/, ""));
      if (!m) break;
      const list = m[1] === "tags" || m[1] === "alias";
      if (m[1] !== "title") props[m[1]] = list ? m[2].split(",").map((x) => x.trim().replace(/^\[\[|\]\]$/g, "").replace(/^#/, "")).filter(Boolean) : propValue(m[2]);
      first = false;
      i++;
    }
    const out: string[] = [];
    for (const raw of lines.slice(i)) {
      const idm = /^\s*id:: (\S+)\s*$/.exec(raw);
      if (idm && UUID.test(idm[1])) {
        // The id belongs to the block above: `^id` at its end.
        for (let k = out.length - 1; k >= 0; k--) {
          if (out[k].trim()) {
            out[k] = `${out[k]} ^${idm[1].toLowerCase()}`;
            break;
          }
        }
        continue;
      }
      if (/^\s*collapsed:: (true|false)\s*$/.test(raw)) continue;
      let line = raw
        .replace(/^(\s*-\s+)(TODO|LATER|NOW|DOING|WAIT|WAITING)\s+/, "$1[ ] ")
        .replace(/^(\s*-\s+)(DONE)\s+/, "$1[x] ")
        .replace(/^(\s*-\s+)(CANCELED|CANCELLED)\s+(.*)$/, "$1[x] ~~$3~~");
      line = line.replace(/\{\{embed \(\(([^)]+)\)\)\s*\}\}/g, (m, id: string) => {
        const p = blockPage.get(id.toLowerCase());
        return p ? `![[${linkTo(p.name)}#^${id.toLowerCase()}]]` : m;
      });
      line = line.replace(/\{\{embed \[\[([^\]]+)\]\]\s*\}\}/g, (_, t: string) => `![[${linkTo(t)}]]`);
      line = line.replace(/\(\(([0-9a-f-]{36})\)\)/gi, (m, id: string) => {
        const p = blockPage.get(id.toLowerCase());
        return p ? `[[${linkTo(p.name)}#^${id.toLowerCase()}]]` : m;
      });
      line = line.replace(/#\[\[([^\]]+)\]\]/g, (_, t: string) => `[[${linkTo(t)}|${t}]]`);
      line = line.replace(/(?<!!)\[\[([^\]|#]+)((?:#[^\]|]*)?)(\|[^\]]*)?\]\]/g, (m, t: string, frag: string, alias: string | undefined) => {
        if (!find(t)) return m;
        const to = linkTo(t);
        return `[[${to}${frag}${alias ?? (to !== t ? `|${t}` : "")}]]`;
      });
      // Asset links are written from pages/ (`../assets/x.png`): from the page's new folder.
      line = line.replace(/(!?\[[^\]]*\]\()(<[^>]+>|[^)\s]+)(\))/g, (m, open: string, dest: string, close: string) => {
        const d = dest.replace(/^<|>$/g, "");
        if (/^[a-z]+:/i.test(d) || !/assets\//.test(d)) return m;
        let decoded = d;
        try {
          decoded = decodeURIComponent(d);
        } catch {
          // why: not percent-encoded: the link target is used as written
          /* as written */
        }
        const target = assetPaths.get(resolveRel(dirOf(page.src), decoded).normalize("NFC").toLowerCase());
        return target ? `${open}${mdDest(relativeTo(dirOf(page.path), target))}${close}` : m;
      });
      out.push(line);
    }
    vault.notes.set(page.path, withFrontmatter(props, out.join("\n").replace(/^\n+/, "")));
  }
  return vault;
}
