/**
 * Imported highlights in the vault (plan W2.15): one note per book or
 * article, `Highlights/<Title> — <Author>.md`, with every highlight as an
 * entry the next import recognises:
 *
 *     <!-- hl:1a2b3c4d5e6f sha=0f1e2d3c4b5a src=kindle -->
 *     > the highlighted passage
 *
 *     — p. 12 · loc. 180–182 · 2026-03-10 · [Zotero](zotero://…) #tag
 *
 *     the note
 *     <!-- /hl -->
 *
 * Importing again only adds what's new: an entry whose id is in the note
 * is left as it is (your edits stay) unless the app that wrote it changed
 * it (its `sha` no longer matches), and a highlight the reader extended replaces
 * the shorter one. The same passage from two apps (a Kindle highlight that
 * is also in Readwise) has one id, so it is one entry. Anything you write
 * outside the entries is kept.
 */

import { fnv, normText, type ImportSource, type ImportedBook, type ImportedHighlight } from "./model";

export const NOTES_DIR = "Highlights";
const ENTRY = /<!-- hl:([0-9a-f]{12})(?: sha=([0-9a-f]{12}))?(?: src=([a-z]+))? -->\n([\s\S]*?)\n<!-- \/hl -->/g;

/** A vault-safe file name: letters of any script (Hebrew kept), digits, spaces and a few marks. */
export function safeName(s: string, max = 90): string {
  const out = s
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, max)
    .trim();
  return out || "Untitled";
}

export function bookNotePath(book: Pick<ImportedBook, "title" | "author">): string {
  const name = book.author ? `${safeName(book.title, 70)} — ${safeName(book.author, 40)}` : safeName(book.title);
  return `${NOTES_DIR}/${name}.md`;
}

/** What the source said, for telling a changed highlight from an unchanged one. */
const fingerprint = (h: ImportedHighlight) => fnv([normText(h.text), normText(h.note), h.location ?? "", h.tags.join(",")].join("\u0000"));

const yaml = (s: string) => JSON.stringify(s);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function entryMarkdown(h: ImportedHighlight, source: ImportSource): string {
  const quote = h.text ? h.text.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n") : null;
  const link = h.link ? `[${source === "zotero" ? "Zotero" : "↗"}](<${h.link}>)` : null;
  const meta = ["—", [h.location, day(h.created), link, ...h.tags.map((t) => `#${t}`)].filter(Boolean).join(" · ")].join(" ");
  const parts = [quote, meta.length > 2 ? meta : null, h.note || null].filter((p): p is string => !!p);
  return `<!-- hl:${h.id} sha=${fingerprint(h)} src=${source} -->\n${parts.join("\n\n")}\n<!-- /hl -->`;
}

interface Entry {
  id: string;
  sha: string | null;
  src: string | null;
  start: number;
  end: number;
  body: string;
}

function entriesOf(md: string): Entry[] {
  return [...md.matchAll(ENTRY)].map((m) => ({ id: m[1], sha: m[2] ?? null, src: m[3] ?? null, start: m.index!, end: m.index! + m[0].length, body: m[4] }));
}

/** The passage of an entry as written (the quote lines). */
function quoteOf(body: string): string {
  return body
    .split("\n")
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n");
}

function header(book: ImportedBook, sources: string[]): string {
  const fm = ["---", `title: ${yaml(book.title)}`, ...(book.author ? [`author: ${yaml(book.author)}`] : []), `highlights-import: [${sources.join(", ")}]`, ...(book.link ? [`source-link: ${yaml(book.link)}`] : []), "---"].join("\n");
  const by = [book.author ? `*${book.author}*` : null, book.link ? `[${book.source === "zotero" ? "Open in Zotero" : "Source"}](<${book.link}>)` : null].filter(Boolean).join(" · ");
  return `${fm}\n# ${book.title}\n${by ? `\n${by}\n` : ""}`;
}

export interface MergeResult {
  content: string;
  added: number;
  updated: number;
  unchanged: number;
}

/** The book's note after this import: `existing` (or a new note) with the new and changed entries. */
export function mergeBookNote(existing: string | null, book: ImportedBook): MergeResult {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  if (existing === null) {
    const body = book.highlights.map((h) => entryMarkdown(h, book.source)).join("\n\n");
    return { content: `${header(book, [book.source])}\n${body}\n`, added: book.highlights.length, updated: 0, unchanged: 0 };
  }
  let md = existing;
  // The sources line of the frontmatter.
  md = md.replace(/^(---\n[\s\S]*?^highlights-import: \[)([^\]]*)(\][\s\S]*?^---)/m, (all, a: string, list: string, b: string) => {
    const have = list.split(",").map((s) => s.trim()).filter(Boolean);
    return have.includes(book.source) ? all : `${a}${[...have, book.source].join(", ")}${b}`;
  });
  const appended: string[] = [];
  for (const h of book.highlights) {
    const entries = entriesOf(md);
    const same = entries.find((e) => e.id === h.id);
    if (same) {
      // Only the app that wrote an entry updates it (the same passage from another app is the same highlight).
      if (same.sha === fingerprint(h) || same.sha === null || (same.src !== null && same.src !== book.source)) unchanged++;
      else {
        md = md.slice(0, same.start) + entryMarkdown(h, book.source) + md.slice(same.end);
        updated++;
      }
      continue;
    }
    // A highlight the reader extended: the new passage holds an old one whole.
    const n = normText(h.text);
    const shorter = n ? entries.find((e) => {
      const q = normText(quoteOf(e.body));
      return q.length >= 12 && q !== n && n.includes(q);
    }) : undefined;
    if (shorter) {
      md = md.slice(0, shorter.start) + entryMarkdown(h, book.source) + md.slice(shorter.end);
      updated++;
      continue;
    }
    appended.push(entryMarkdown(h, book.source));
    added++;
  }
  if (appended.length) md = `${md.replace(/\s*$/, "")}\n\n${appended.join("\n\n")}\n`;
  return { content: md, added, updated, unchanged };
}

/* ─── Reading the notes back (for the highlights hub) ─────────────── */

export interface ImportedEntry {
  id: string;
  text: string;
  note: string;
  tags: string[];
  location: string | null;
  link: string | null;
  created: string | null;
}

/** Is this an imported-highlights note? */
export const isImportNote = (md: string) => /^---\n[\s\S]*?^highlights-import:/m.test(md);

export function readImportNote(md: string): { title: string; author: string; entries: ImportedEntry[] } {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  const field = (k: string) => {
    const m = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm);
    if (!m) return "";
    try {
      return JSON.parse(m[1]) as string;
    } catch {
      return m[1].trim();
    }
  };
  return {
    title: field("title"),
    author: field("author"),
    entries: entriesOf(md).map((e) => {
      const blocks = e.body.split(/\n\n+/);
      const metaIdx = blocks.findIndex((b) => b.startsWith("— ") || b === "—");
      const meta = metaIdx >= 0 ? blocks[metaIdx] : "";
      const rest = blocks.filter((b, i) => i !== metaIdx && !b.startsWith(">")).join("\n\n");
      const link = /\]\(<([^>]+)>\)/.exec(meta)?.[1] ?? null;
      const tags = [...meta.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1]);
      const pieces = meta.replace(/^—\s?/, "").split(" · ").map((p) => p.trim());
      const loc = pieces.filter((p) => p && !/^\[/.test(p) && !/^#/.test(p) && !/^\d{4}-\d\d-\d\d$/.test(p));
      const created = pieces.find((p) => /^\d{4}-\d\d-\d\d$/.test(p)) ?? null;
      return { id: e.id, text: quoteOf(e.body), note: rest.trim(), tags, location: loc.join(" · ") || null, link, created };
    }),
  };
}
