/**
 * Pandoc citation syntax (plan W2.16), the way pandoc and Zettlr read it:
 *
 *   [@doe2020]                    (Doe, 2020)
 *   [@doe2020, p. 10]             a locator
 *   [see @doe2020, pp. 3–5; @roe] a prefix, a range, two sources
 *   [-@doe2020]                   the year only (the name is in the sentence)
 *   @doe2020 says …               in-text: Doe (2020) says …
 *   @doe2020 [p. 10] says …       in-text with a locator
 *
 * Locator labels (English and Hebrew): p. / pp. / page, chap. / ch., sec.,
 * fig., vol., para., n., l. / ll., עמ׳ / עמ' / עמוד, פרק, כרך, סעיף.
 * Code spans, fenced code and e-mail addresses are never citations.
 */
import { KEY } from "./keys";

export type LocatorLabel = "page" | "chapter" | "section" | "figure" | "volume" | "paragraph" | "note" | "line";

export interface CiteItem {
  key: string;
  prefix: string;
  suffix: string;
  locator: { label: LocatorLabel; value: string } | null;
  suppressAuthor: boolean;
}

export interface Cluster {
  /** Position in the source: [start, end). */
  start: number;
  end: number;
  items: CiteItem[];
  /** `@key` outside brackets: the author is part of the sentence. */
  inText: boolean;
}

const LABELS: Array<[RegExp, LocatorLabel]> = [
  [/^(?:pp?\.|pages?|\u05E2\u05DE['\u05F3]|\u05E2\u05DE\u05D5\u05D3\u05D9\u05DD|\u05E2\u05DE\u05D5\u05D3)\s*/i, "page"],
  [/^(?:chap\.|ch\.|chapters?|פרקים|פרק)\s*/i, "chapter"],
  [/^(?:sec\.|§|sections?|סעיף|סעיפים)\s*/i, "section"],
  [/^(?:fig\.|figures?|איור)\s*/i, "figure"],
  [/^(?:vol\.|volumes?|כרך)\s*/i, "volume"],
  [/^(?:para\.|paragraphs?|¶|פסקה)\s*/i, "paragraph"],
  [/^(?:nn?\.|notes?|הערה)\s*/i, "note"],
  [/^(?:ll?\.|lines?|שורה|שורות)\s*/i, "line"],
];

/** "p. 10", "pp. 3-5, and passim", "10" (a bare number is a page). */
export function parseLocator(text: string): { locator: CiteItem["locator"]; suffix: string } {
  const s = text.replace(/^\s*,?\s*/, "");
  if (!s) return { locator: null, suffix: "" };
  for (const [re, label] of LABELS) {
    const m = re.exec(s);
    if (!m) continue;
    const v = /^([\p{N}\p{L}]+(?:\s*[-\u2013—]\s*[\p{N}\p{L}]+)?(?:\s*,\s*[\p{N}]+(?:\s*[-\u2013—]\s*[\p{N}]+)?)*)(.*)$/u.exec(s.slice(m[0].length));
    if (v) return { locator: { label, value: v[1].replace(/\s*[-—]\s*/g, "\u2013").replace(/\s*\u2013\s*/g, "\u2013") }, suffix: v[2].replace(/^\s*,?\s*/, "") };
  }
  const bare = /^(\d+(?:\s*[-\u2013]\s*\d+)?)(.*)$/.exec(s);
  if (bare) return { locator: { label: "page", value: bare[1].replace(/\s*[-\u2013]\s*/g, "\u2013") }, suffix: bare[2].replace(/^\s*,?\s*/, "") };
  return { locator: null, suffix: s };
}

const ITEM = new RegExp(`^(.*?)(-?)@(${KEY.source})(.*)$`, "su");

/** The inside of a bracket, or null when it isn't a citation. */
export function parseBracket(inner: string): CiteItem[] | null {
  const parts = inner.split(";");
  const items: CiteItem[] = [];
  for (const part of parts) {
    const m = ITEM.exec(part.trim());
    if (!m) return null;
    const { locator, suffix } = parseLocator(m[4]);
    items.push({ key: m[3], prefix: m[1].trim(), suffix, locator, suppressAuthor: m[2] === "-" });
  }
  return items.length ? items : null;
}

/** Ranges of code (fences and spans) that hold no citations. */
function codeRanges(md: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of md.matchAll(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1\2[`~]*\s*$|(?![\s\S]))/gm)) out.push([m.index!, m.index! + m[0].length]);
  for (const m of md.matchAll(/(`+)[^`]+?\1/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Every citation in a Markdown text, in order. */
export function findCitations(md: string): Cluster[] {
  const code = codeRanges(md);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  const out: Cluster[] = [];
  // Bracketed: [ … @key … ], not a link ([text](url)) and not [@key](url).
  for (const m of md.matchAll(/\[([^[\]\n]*?-?@[^[\]\n]*?)\](?![(:[])/g)) {
    if (inCode(m.index!)) continue;
    const items = parseBracket(m[1]);
    if (items) out.push({ start: m.index!, end: m.index! + m[0].length, items, inText: false });
  }
  // In-text: @key at a word start (not an e-mail), optionally followed by [locator].
  const inText = new RegExp(`(^|[\\s(—–"“'])@(${KEY.source})(\\s*\\[([^\\]\\n@]*)\\])?`, "gmu");
  for (const m of md.matchAll(inText)) {
    const start = m.index! + m[1].length;
    if (inCode(start) || out.some((c) => start >= c.start && start < c.end)) continue;
    const loc = m[4] !== undefined ? parseLocator(m[4]) : { locator: null, suffix: "" };
    out.push({ start, end: m.index! + m[0].length, items: [{ key: m[2], prefix: "", suffix: loc.suffix, locator: loc.locator, suppressAuthor: false }], inText: true });
  }
  return out.sort((a, b) => a.start - b.start);
}
