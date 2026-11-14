/**
 * Plan W6.38: how faithfully an importer or a paste kept a document. Pure
 * functions over the Markdown a converter wrote and what the source holds:
 * headings, list items (depth and kind), table rows, links, images and
 * right-to-left text. Used by src/__tests__/realCorpus.test.ts.
 */

export interface Expect {
  headings: { level: number; text: string }[];
  items: { depth: number; ordered: boolean; text: string }[];
  rows: string[][];
  links: { text: string; href: string }[];
  images: number;
  /** The document's Hebrew words, in reading order. */
  hebrew: string[];
}

export interface Feature {
  want: number;
  got: number;
}
export type Score = Record<"headings" | "lists" | "tables" | "links" | "images" | "rtl", Feature>;

const norm = (s: string) =>
  s
    .normalize("NFC")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/[*_`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Hebrew words (runs of Hebrew letters, quote marks inside a word kept). */
export function hebrewWords(s: string): string[] {
  return s.normalize("NFC").match(/[א-ת][א-ת"״'׳]*[א-ת]|[א-ת]/g) ?? [];
}

/** Longest common subsequence length: words kept in reading order. */
export function inOrder(want: string[], got: string[]): number {
  if (!want.length) return 0;
  let prev = new Uint16Array(got.length + 1);
  for (const w of want) {
    const cur = new Uint16Array(got.length + 1);
    for (let j = 1; j <= got.length; j++) cur[j] = w === got[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[got.length];
}

interface ModelRun {
  text: string;
  href?: string;
}
type ModelBlock =
  | { t: "h"; level: number; text: string }
  | { t: "p"; runs: ModelRun[] }
  | { t: "ul" | "ol"; items: { text: string; children?: { text: string }[] }[] }
  | { t: "table"; rows: string[][] }
  | { t: "img"; src: string; alt: string };
export interface ModelDoc {
  id: string;
  dir: "rtl" | "ltr";
  blocks: ModelBlock[];
}

/** What a source document of the corpus model holds. */
export function expectOf(doc: ModelDoc): Expect {
  const e: Expect = { headings: [], items: [], rows: [], links: [], images: 0, hebrew: [] };
  const text: string[] = [];
  for (const b of doc.blocks) {
    if (b.t === "h") {
      e.headings.push({ level: b.level, text: b.text });
      text.push(b.text);
    } else if (b.t === "p") {
      for (const r of b.runs) if (r.href) e.links.push({ text: r.text, href: r.href });
      text.push(b.runs.map((r) => r.text).join(""));
    } else if (b.t === "ul" || b.t === "ol") {
      for (const it of b.items) {
        e.items.push({ depth: 1, ordered: b.t === "ol", text: it.text });
        text.push(it.text);
        for (const c of it.children ?? []) {
          e.items.push({ depth: 2, ordered: b.t === "ol", text: c.text });
          text.push(c.text);
        }
      }
    } else if (b.t === "table") {
      e.rows.push(...b.rows);
      for (const r of b.rows) text.push(r.join(" "));
    } else e.images++;
  }
  e.hebrew = hebrewWords(text.join("\n"));
  return e;
}

interface MdItem {
  depth: number;
  ordered: boolean;
  text: string;
}

/** The structure of a Markdown text, read line by line (no Markdown library: the test runs anywhere). */
export function readMarkdown(md: string) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const headings: { level: number; text: string }[] = [];
  const items: MdItem[] = [];
  const rows: string[][] = [];
  const indents: number[] = [];
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: norm(h[2]) });
    const li = /^(\s*)(?:>\s*)?([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      const indent = li[1].replace(/\t/g, "    ").length;
      while (indents.length && indents[indents.length - 1] > indent) indents.pop();
      if (!indents.length || indents[indents.length - 1] < indent) indents.push(indent);
      items.push({ depth: indents.length, ordered: /\d/.test(li[2]), text: norm(li[3]) });
    } else if (line.trim() && !/^\s/.test(line)) indents.length = 0;
    if (/^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) rows.push(line.trim().slice(1, -1).split("|").map((c) => norm(c)));
  }
  const links = [...md.matchAll(/(?<!!)\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)].map((m) => ({ text: norm(m[1]), href: m[2] }));
  const images = (md.match(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]/g) ?? []).length;
  return { headings, items, rows, links, images };
}

const controls = (s: string) => (s.match(/[‪-‮⁦-⁩]/g) ?? []).length;

/** Score one converted document against what its source holds. */
export function score(md: string, e: Expect, opts: { hrefMatch?: (want: string, got: string) => boolean } = {}): Score {
  const got = readMarkdown(md);
  const decode = (u: string) => {
    try {
      return decodeURI(u);
    } catch {
      return u;
    }
  };
  const hrefMatch = opts.hrefMatch ?? ((w, g) => w === g || decode(w) === decode(g) || decode(w).replace(/&amp;/g, "&") === decode(g));
  const take = <T,>(pool: T[], pred: (x: T) => boolean) => {
    const i = pool.findIndex(pred);
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };
  const hs = [...got.headings];
  const its = [...got.items];
  const rs = [...got.rows];
  const ls = [...got.links];
  const hebrew = hebrewWords(md);
  return {
    headings: { want: e.headings.length, got: e.headings.filter((h) => take(hs, (x) => x.level === h.level && x.text === norm(h.text))).length },
    lists: { want: e.items.length, got: e.items.filter((it) => take(its, (x) => x.depth === it.depth && x.ordered === it.ordered && x.text === norm(it.text))).length },
    tables: { want: e.rows.length, got: e.rows.filter((r) => take(rs, (x) => x.length === r.length && x.every((c, i) => c === norm(r[i])))).length },
    // A link around blocks (a web clip's search result: a heading and a citation) comes out as a link per block: any part of its text counts.
    links: { want: e.links.length, got: e.links.filter((l) => take(ls, (x) => hrefMatch(l.href, x.href) && (x.text === norm(l.text) || (x.text.length > 0 && norm(l.text).includes(x.text))))).length },
    images: { want: e.images, got: Math.min(e.images, got.images) },
    // RTL: every Hebrew word in reading order, and no stray direction embedding or override.
    rtl: { want: e.hebrew.length, got: controls(md) ? 0 : inOrder(e.hebrew, hebrew) },
  };
}

export const perfect = (s: Score) => Object.values(s).every((f) => f.got === f.want);

/** Sum the scores of a set of documents, feature by feature. */
export function total(scores: Score[]): Score {
  const t: Score = { headings: { want: 0, got: 0 }, lists: { want: 0, got: 0 }, tables: { want: 0, got: 0 }, links: { want: 0, got: 0 }, images: { want: 0, got: 0 }, rtl: { want: 0, got: 0 } };
  for (const s of scores) for (const k of Object.keys(t) as (keyof Score)[]) {
    t[k].want += s[k].want;
    t[k].got += s[k].got;
  }
  return t;
}

/** What an ENML note (Evernote's XHTML) holds, read from its DOM. */
export function expectOfEnml(enml: string, parse: (html: string) => Document): Expect {
  const doc = parse(enml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/gi, "").replace(/<en-note/g, "<div").replace(/<\/en-note>/g, "</div>"));
  const body = doc.body;
  const e: Expect = { headings: [], items: [], rows: [], links: [], images: 0, hebrew: hebrewWords(body.textContent ?? "") };
  for (const h of Array.from(body.querySelectorAll("h1,h2,h3,h4,h5,h6"))) if (norm(h.textContent ?? "")) e.headings.push({ level: +h.tagName[1], text: h.textContent ?? "" });
  for (const li of Array.from(body.querySelectorAll("li"))) {
    let depth = 0;
    for (let p: Element | null = li.parentElement; p; p = p.parentElement) if (p.tagName === "UL" || p.tagName === "OL") depth++;
    const own = Array.from(li.childNodes)
      .filter((n) => !(n instanceof Element && (n.tagName === "UL" || n.tagName === "OL")))
      .map((n) => n.textContent ?? "")
      .join("");
    if (norm(own)) e.items.push({ depth, ordered: li.parentElement?.tagName === "OL", text: own });
  }
  for (const tr of Array.from(body.querySelectorAll("tr"))) {
    const cells = Array.from(tr.children).map((c) => c.textContent ?? "");
    if (cells.some((c) => norm(c))) e.rows.push(cells);
  }
  for (const a of Array.from(body.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (/^https?:/i.test(href) && norm(a.textContent ?? "")) e.links.push({ text: a.textContent ?? "", href });
  }
  e.images = body.querySelectorAll("en-media[type^='image/'],img").length;
  return e;
}
