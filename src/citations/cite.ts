/**
 * Citations and the reference list (plan W2.16) on the 6.13 templates:
 * APA 7, Chicago author-date, MLA 9 — and "il", APA 7 the way Israeli
 * academic libraries teach it (Beit Berl library's APA 7 guide): Hebrew
 * sources first in their own list, then the rest; each source in its own
 * language's terms whatever the document's language; Hebrew initials with a
 * geresh (דרשן, ד׳); the same author and year told apart by א, ב (Hebrew)
 * or a, b; a title-first entry sorted by its first word without ה / The.
 *
 * Own templates, no citeproc (decision 15.10).
 *
 * W11.H15, from the Bar-Ilan (lib.biu.ac.il/en/Education/APA7) and Haifa
 * (lib.haifa.ac.il apaheb.pdf) library guides: no comma before the ו of the
 * last Hebrew author; three or more authors in the text are "X ואחרים";
 * and in a right-to-left document every parenthetical — "(Austen, 1813)",
 * "(2022א)" — is a first-strong isolate (FSI … PDI), so its brackets and
 * an English name inside Hebrew text do not flip (the reversed ")2009("
 * that Word and PDF exports show).
 */
import { formatReference, plainTitle, type CitationLang, type CitationRecord, type Run } from "../data/citationStyles";
import type { CiteItem, Cluster, LocatorLabel } from "./pandoc";

export type Style = "apa" | "chicago" | "mla" | "il";
export const STYLES: ReadonlyArray<{ id: Style; label: string }> = [
  { id: "apa", label: "APA 7" },
  { id: "chicago", label: "Chicago (author-date)" },
  { id: "mla", label: "MLA 9" },
  { id: "il", label: "APA 7 — Israeli academic (Hebrew first)" },
];

const HEBREW = /[\u0590-\u05FF]/;
export const isHebrewRecord = (r: CitationRecord) => HEBREW.test(r.authors[0]?.family ?? "") || (!r.authors.length && HEBREW.test(r.title));

/** The language a source is written in for a style: the document's, except "il", where each source keeps its own. */
const langFor = (r: CitationRecord, style: Style, docLang: CitationLang): CitationLang => (style === "il" ? (isHebrewRecord(r) ? "he" : "en") : docLang);
const base = (style: Style) => (style === "il" ? "apa" : style);

const LOC: Record<CitationLang, Record<LocatorLabel, [string, string]>> = {
  en: { page: ["p.", "pp."], chapter: ["chap.", "chaps."], section: ["sec.", "secs."], figure: ["fig.", "figs."], volume: ["vol.", "vols."], paragraph: ["para.", "paras."], note: ["n.", "nn."], line: ["l.", "ll."] },
  he: { page: ["עמ׳", "עמ׳"], chapter: ["פרק", "פרקים"], section: ["סעיף", "סעיפים"], figure: ["איור", "איורים"], volume: ["כרך", "כרכים"], paragraph: ["פסקה", "פסקאות"], note: ["הערה", "הערות"], line: ["שורה", "שורות"] },
};
const MLA_EN: Partial<Record<LocatorLabel, [string, string]>> = { chapter: ["ch.", "chs."], line: ["line", "lines"] };

/** A locator as the style writes it: APA "p. 10", Chicago "10" (pages bare), MLA "10" / "ch. 3". */
export function locatorText(loc: CiteItem["locator"], style: Style, lang: CitationLang): string {
  if (!loc) return "";
  const plural = /[\u2013,-]/.test(loc.value) ? 1 : 0;
  if (loc.label === "page" && (style === "chicago" || style === "mla")) return loc.value;
  const words = style === "mla" && lang === "en" ? (MLA_EN[loc.label] ?? LOC.en[loc.label]) : LOC[lang][loc.label];
  return `${words[plural]} ${loc.value}`;
}

const TERMS = { en: { and: "and", amp: "&", etAl: "et al.", nd: "n.d." }, he: { and: "ו", amp: "ו", etAl: "ואחרים", nd: "ללא תאריך" } } as const;
const andWord = (lang: CitationLang, next: string, amp: boolean) => (lang === "he" ? (HEBREW.test(next[0] ?? "") ? `ו${next}` : `ו-${next}`) : `${amp ? "&" : "and"} ${next}`);

/** Who, as the in-text citation names them. */
export function citedNames(r: CitationRecord, style: Style, lang: CitationLang, narrative = false): string {
  const fam = r.authors.map((a) => a.family);
  const amp = (style === "apa" || style === "il") && !narrative;
  if (!fam.length) return style === "mla" || style === "chicago" ? `“${plainTitle(r.title)}”` : plainTitle(r.title);
  if (fam.length === 1) return fam[0];
  if (fam.length === 2) return `${fam[0]} ${andWord(lang, fam[1], amp)}`;
  return `${fam[0]} ${TERMS[lang].etAl}`;
}

/** Year suffixes for the same first author and year among the cited sources: a, b (or א, ב for Hebrew sources in "il"). */
export function yearSuffixes(records: ReadonlyArray<{ key: string; record: CitationRecord }>, style: Style): Map<string, string> {
  const out = new Map<string, string>();
  if (style === "mla") return out;
  const groups = new Map<string, Array<{ key: string; record: CitationRecord }>>();
  for (const x of records) {
    const k = `${x.record.authors.map((a) => a.family).join("|") || x.record.title}\u0000${x.record.year ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => sortTitle(a.record.title).localeCompare(sortTitle(b.record.title), "he"));
    g.forEach((x, i) => out.set(x.key, style === "il" && isHebrewRecord(x.record) ? "אבגדהוזחטיכלמנסעפצקרשת"[i] : String.fromCharCode(97 + i)));
  }
  return out;
}

const sortTitle = (t: string) => plainTitle(t).replace(/^(?:the|a|an)\s+/i, "").replace(/^\u05D4(?=[\u05D0-\u05EA]{2})/, "");

export interface CiteContext {
  style: Style;
  lang: CitationLang;
  lookup: (key: string) => CitationRecord | undefined;
  suffix: Map<string, string>;
}

const yearOf = (r: CitationRecord, key: string, ctx: CiteContext, lang: CitationLang) => `${r.year ?? TERMS[lang].nd}${ctx.suffix.get(key) ?? ""}`;

const FSI = "\u2068";
const PDI = "\u2069";

/**
 * Each top-level balanced "(…)" of `text` wrapped in FSI … PDI. One already
 * wrapped is left alone, and an unbalanced bracket is not touched.
 */
export function isolateParentheticals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "(" || text[i - 1] === FSI) {
      out += text[i++];
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    if (j >= text.length) {
      out += text[i++];
      continue;
    }
    const inner = text.slice(i, j + 1);
    out += text[j + 1] === PDI ? inner : `${FSI}${inner}${PDI}`;
    i = j + 1;
  }
  return out;
}

/** One cluster as text: "(Doe, 2020, p. 10; Roe, 2019)" — or "Doe (2020, p. 10)" in-text. Unknown keys stay as written. */
export function formatCluster(c: Cluster, ctx: CiteContext, original: string): string {
  const out = formatClusterText(c, ctx, original);
  // A Hebrew (right-to-left) document: the parentheticals are isolates (W11.H15).
  return ctx.lang === "he" && out !== original ? isolateParentheticals(out) : out;
}

function formatClusterText(c: Cluster, ctx: CiteContext, original: string): string {
  const parts: string[] = [];
  for (const it of c.items) {
    const r = ctx.lookup(it.key);
    if (!r) return original;
    const lang = langFor(r, ctx.style, ctx.lang);
    const loc = locatorText(it.locator, ctx.style, lang);
    const y = yearOf(r, it.key, ctx, lang);
    const extra = [loc, it.suffix].filter(Boolean).join(", ");
    if (c.inText) {
      const who = citedNames(r, ctx.style, lang, true);
      if (ctx.style === "mla") return `${who}${extra ? ` (${extra})` : ""}`;
      return `${who} (${y}${extra ? `, ${extra}` : ""})`;
    }
    const who = it.suppressAuthor ? "" : citedNames(r, ctx.style, lang);
    let one: string;
    if (ctx.style === "mla") one = [who, extra].filter(Boolean).join(" ");
    else if (ctx.style === "chicago") one = `${[who, y].filter(Boolean).join(" ")}${extra ? `, ${extra}` : ""}`;
    else one = `${[who, y].filter(Boolean).join(", ")}${extra ? `, ${extra}` : ""}`;
    parts.push([it.prefix, one].filter(Boolean).join(" "));
  }
  return `(${parts.join("; ")})`;
}

/** Hebrew initials with a geresh, as the Israeli guide writes them: "דרשן, ד." → "דרשן, ד׳". */
function hebrewInitials(runs: Run[]): Run[] {
  return runs.map((r) => ({ ...r, t: r.t.replace(/(^|[\s,(]|[\s,(]\u05D5-?)([\u05D0-\u05EA])\.(?=[\s,)]|$)/g, "$1$2\u05F3") }));
}

/** A year suffix into the reference's year: "(2022)." → "(2022א).". */
function withSuffix(runs: Run[], r: CitationRecord, suffix: string | undefined): Run[] {
  if (!suffix || !r.year) return runs;
  let done = false;
  return runs.map((x) => {
    if (done) return x;
    const t = x.t.replace(new RegExp(`(\\(?)${r.year}(\\)?)`), (_, a: string, b: string) => ((done = true), `${a}${r.year}${suffix}${b}`));
    return { ...x, t };
  });
}

export interface BibEntryOut {
  key: string;
  lang: CitationLang;
  runs: Run[];
}

/** The reference list of the cited sources, sorted the style's way ("il": Hebrew list first). */
export function bibliography(cited: ReadonlyArray<{ key: string; record: CitationRecord }>, ctx: Omit<CiteContext, "lookup">): BibEntryOut[][] {
  const sortName = (r: CitationRecord) => (r.authors.length ? r.authors.map((a) => `${a.family} ${a.given ?? ""}`).join(" ") : sortTitle(r.title));
  const order = (xs: Array<{ key: string; record: CitationRecord }>) =>
    [...xs].sort((a, b) => sortName(a.record).localeCompare(sortName(b.record), isHebrewRecord(a.record) ? "he" : "en", { sensitivity: "base" }) || (a.record.year ?? "").localeCompare(b.record.year ?? "") || (ctx.suffix.get(a.key) ?? "").localeCompare(ctx.suffix.get(b.key) ?? ""));
  const entry = (x: { key: string; record: CitationRecord }): BibEntryOut => {
    const lang = langFor(x.record, ctx.style, ctx.lang);
    let runs = formatReference(x.record, base(ctx.style), lang);
    runs = withSuffix(runs, x.record, ctx.suffix.get(x.key));
    if (ctx.style === "il" && lang === "he") runs = hebrewInitials(runs);
    // A Hebrew entry is read right to left: its parentheticals are isolates (W11.H15).
    if (lang === "he") runs = runs.map((r) => ({ ...r, t: isolateParentheticals(r.t) }));
    return { key: x.key, lang, runs };
  };
  if (ctx.style !== "il") return [order([...cited]).map(entry)];
  const he = cited.filter((x) => isHebrewRecord(x.record));
  const rest = cited.filter((x) => !isHebrewRecord(x.record));
  return [order(he).map(entry), order(rest).map(entry)].filter((l) => l.length);
}
