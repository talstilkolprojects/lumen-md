/**
 * Reference lists in APA 7, Chicago author-date (18th ed., which no longer
 * asks for the place of publication) and MLA 9, in
 * English or Hebrew, offline (plan 6.13).
 *
 * Plan 6.13 names two ways to format: citeproc with CSL styles, or our own
 * templates for the three styles. citeproc is CPAL-1.0 / AGPL (decision
 * 15.10 is open), so this file is the second way: written-down rules, no
 * dependency, nothing fetched. If 15.10 picks citeproc, it replaces
 * `formatReference` / `formatInText` behind the same interface.
 *
 * Hebrew changes the words, not the order: "and" / "&" → ו (ו- before a
 * non-Hebrew word), "et al." → ואחרים, MLA's vol. / no. / pp. → כרך /
 * גיליון / עמ׳, "n.d." → ללא תאריך. Names, titles and publishers stay as
 * they were published.
 *
 * Output is a list of runs (text, italic or not) so the block renders
 * <em> without HTML strings; `runsToMarkdown` gives the Markdown form.
 */

import type { BibEntry } from "./bibtex";

export type CitationStyle = "apa" | "chicago" | "mla";
export type CitationLang = "en" | "he";
export const CITATION_STYLES: ReadonlyArray<{ id: CitationStyle; label: string }> = [
  { id: "apa", label: "APA 7" },
  { id: "chicago", label: "Chicago (author-date)" },
  { id: "mla", label: "MLA 9" },
];

export interface Name {
  family: string;
  given?: string;
  suffix?: string;
}

export interface CitationRecord {
  type: "book" | "article" | "chapter" | "thesis" | "report" | "web" | "misc";
  authors: Name[];
  editors?: Name[];
  year?: string;
  /** As published (title case for English). */
  title: string;
  /** APA sentence case; computed from `title` when absent. */
  titleSentence?: string;
  /** Journal, book (for a chapter) or site. */
  container?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  /** "891–921" (an en dash) or a single page. */
  pages?: string;
  doi?: string;
  url?: string;
  edition?: string;
}

export interface Run {
  t: string;
  i?: boolean;
}

const TERMS = {
  en: { and: "and", amp: "&", etAl: "et al.", vol: "vol.", no: "no.", pp: "pp.", p: "p.", nd: "n.d.", ed: "edited by", in: "In", eds: "Eds.", edOne: "Ed." },
  he: { and: "ו", amp: "ו", etAl: "ואחרים", vol: "כרך", no: "גיליון", pp: "עמ׳", p: "עמ׳", nd: "ללא תאריך", ed: "בעריכת", in: "בתוך", eds: "עורכים", edOne: "עורך" },
} as const;

const HEBREW = /^[֐-׿]/;
/** "and X": in Hebrew the conjunction is a prefix, with a hyphen before a non-Hebrew word. */
function and(lang: CitationLang, next: string, word: "and" | "amp" = "and"): string {
  if (lang === "he") return HEBREW.test(next) ? `ו${next}` : `ו-${next}`;
  return `${TERMS.en[word]} ${next}`;
}

const endWith = (s: string, mark = ".") => (/[.?!]$/.test(s.trim()) ? s.trim() : `${s.trim()}${mark}`);
const stripEnd = (s: string) => s.trim().replace(/\.$/, "");

// ── Names ───────────────────────────────────────────────────────────────

/** "A. M." from "Alan M.", "H. G." stays, "Mary Wollstonecraft" → "M. W.". Hyphenated: "J.-P.". */
export function initials(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((g) => (/^\p{Lu}\.$/u.test(g) ? g : g.split("-").map((p) => `${[...p][0]}.`).join("-")))
    .join(" ");
}

const apaName = (n: Name) => `${n.family}${n.given ? `, ${initials(n.given)}` : ""}${n.suffix ? `, ${n.suffix}` : ""}`;
const invertedName = (n: Name) => `${n.family}${n.given ? `, ${n.given}` : ""}${n.suffix ? `, ${n.suffix}` : ""}`;
const directName = (n: Name) => `${n.given ? `${n.given} ` : ""}${n.family}${n.suffix ? `, ${n.suffix}` : ""}`;

function apaAuthors(names: Name[], lang: CitationLang): string {
  const list = names.map(apaName);
  if (list.length === 1) return list[0];
  if (list.length <= 20) return `${list.slice(0, -1).join(", ")}, ${and(lang, list[list.length - 1], "amp")}`;
  // 21 or more: the first 19, an ellipsis, the last.
  return `${list.slice(0, 19).join(", ")}, … ${list[list.length - 1]}`;
}

function chicagoAuthors(names: Name[], lang: CitationLang): string {
  if (names.length === 1) return invertedName(names[0]);
  if (names.length <= 6) {
    const rest = names.slice(1).map(directName);
    const head = [invertedName(names[0]), ...rest.slice(0, -1)].join(", ");
    return `${head}, ${and(lang, rest[rest.length - 1])}`;
  }
  // Seven or more (18th ed.): the first three, then et al.
  return `${[invertedName(names[0]), ...names.slice(1, 3).map(directName)].join(", ")}, ${TERMS[lang].etAl}`;
}

function mlaAuthors(names: Name[], lang: CitationLang): string {
  if (names.length === 1) return invertedName(names[0]);
  if (names.length === 2) return `${invertedName(names[0])}, ${and(lang, directName(names[1]))}`;
  return `${invertedName(names[0])}, ${TERMS[lang].etAl}`;
}

// ── Titles, pages, publishers ───────────────────────────────────────────

const SMALL = /^(a|an|the|and|but|or|nor|for|so|yet|as|at|by|in|of|off|on|per|to|up|via)$/i;

/**
 * APA sentence case from a BibTeX title: braces keep their words as they
 * are ({DNA}, {Wonderland}); the first word, the first word after a colon
 * and all-caps acronyms keep their capital; the rest is lowercased.
 */
export function sentenceCase(title: string): string {
  let out = "";
  let depth = 0;
  let capNext = true;
  let word = "";
  const flush = () => {
    if (!word) return;
    if (capNext) out += word;
    else if (/^\p{Lu}{2,}s?$/u.test(word) || /\p{Ll}\p{Lu}/u.test(word)) out += word;
    else out += word.toLocaleLowerCase("en");
    capNext = false;
    word = "";
  };
  for (const ch of title) {
    if (ch === "{") {
      flush();
      depth++;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) capNext = false;
      continue;
    }
    if (depth > 0) {
      out += ch;
      continue;
    }
    if (/[\p{L}\p{N}'’-]/u.test(ch)) {
      word += ch;
      continue;
    }
    flush();
    out += ch;
    if (ch === ":" || ch === "?" || ch === "!") capNext = true;
  }
  flush();
  return out;
}

/** Braces gone, for the styles that keep the published capitalization. */
export const plainTitle = (title: string) => title.replace(/[{}]/g, "");

/** Headline case for a title that came in all lowercase (Chicago / MLA); a title with capitals is kept. */
function headline(title: string): string {
  const t = plainTitle(title);
  if (/\p{Lu}/u.test(t)) return t;
  return t
    .split(" ")
    .map((w, i, all) => (i > 0 && i < all.length - 1 && SMALL.test(w) ? w : w.charAt(0).toLocaleUpperCase("en") + w.slice(1)))
    .join(" ");
}

/**
 * The second number of a page range shortened by the style's rule:
 * MLA keeps two digits at least (230–65, 891–921); Chicago 9.61 keeps all
 * digits under 100 and for a first number that is a multiple of 100, only
 * the changed ones for 101–109 in a hundred (101–8, 1103–4) and two or more
 * otherwise (321–28, 1496–500).
 */
export function pageRange(pages: string, style: "chicago" | "mla"): string {
  const m = /^(\d+)\s*[-–—]+\s*(\d+)$/.exec(pages.trim());
  if (!m) return pages.trim().replace(/--/g, "–");
  const [a, b] = [m[1], m[2]];
  const na = Number(a);
  if (b.length !== a.length || na < 100 || Number(b) <= na) return `${a}–${b}`;
  let keep = 0;
  while (keep < a.length && a[keep] === b[keep]) keep++;
  let digits = a.length - keep;
  if (style === "chicago") {
    if (na % 100 === 0) return `${a}–${b}`;
    if (na % 100 < 10) digits = Math.max(digits, 1);
    else digits = Math.max(digits, 2);
  } else digits = Math.max(digits, 2);
  return `${a}–${b.slice(b.length - digits)}`;
}

/** MLA 9 drops business words and shortens University / Press to U / P. */
export function mlaPublisher(name: string): string {
  let p = name
    .trim()
    .replace(/,?\s+(?:and|&)\s+(?:Company|Co\.)$/i, "")
    .replace(/,?\s+(?:Company|Co\.|Inc\.|Ltd\.|Corporation|Corp\.)$/i, "");
  if (/University/.test(p) && /Press$/.test(p)) p = p.replace(/University/, "U").replace(/\s+Press$/, " P");
  return p.replace(/^U P$/, "UP").replace(/\bU P$/, "UP");
}

const doiUrl = (doi: string) => `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
const link = (r: CitationRecord) => (r.doi ? doiUrl(r.doi) : r.url ?? "");

// ── The styles ──────────────────────────────────────────────────────────

function apa(r: CitationRecord, lang: CitationLang): Run[] {
  const who = r.authors.length ? apaAuthors(r.authors, lang) : "";
  const year = `(${r.year ?? TERMS[lang].nd}).`;
  const title = r.titleSentence ?? sentenceCase(r.title);
  const head = who ? `${endWith(who)} ${year}` : "";
  const out: Run[] = [];
  const url = link(r);
  if (r.type === "article") {
    if (head) out.push({ t: `${head} ` });
    out.push({ t: `${endWith(title)} ` });
    if (r.container) {
      out.push({ t: r.container, i: true });
      if (r.volume) {
        out.push({ t: ", " }, { t: r.volume, i: true });
        if (r.issue) out.push({ t: `(${r.issue})` });
      }
      out.push({ t: r.pages ? `, ${r.pages.replace(/--/g, "–")}.` : "." });
    }
  } else if (r.type === "chapter") {
    if (head) out.push({ t: `${head} ` });
    out.push({ t: `${endWith(title)} ` });
    const eds = r.editors?.length ? `${r.editors.map((e) => `${e.given ? `${initials(e.given)} ` : ""}${e.family}`).join(", ")} (${r.editors.length > 1 ? TERMS[lang].eds : TERMS[lang].edOne}), ` : "";
    out.push({ t: `${TERMS[lang].in} ${eds}` });
    if (r.container) out.push({ t: r.container, i: true });
    out.push({ t: r.pages ? ` (${TERMS[lang].pp} ${r.pages.replace(/--/g, "–")}). ` : ". " });
    if (r.publisher) out.push({ t: endWith(r.publisher) });
  } else {
    if (head) out.push({ t: `${head} ` });
    out.push({ t: stripEnd(title), i: true });
    out.push({ t: r.edition ? ` (${r.edition}).` : "." });
    // No author: the title takes the author's place, the date follows it.
    if (!who) out.push({ t: ` ${year}` });
    if (r.publisher) out.push({ t: ` ${endWith(r.publisher)}` });
  }
  if (url) out.push({ t: ` ${url}` });
  return tidy(out);
}

function chicago(r: CitationRecord, lang: CitationLang): Run[] {
  const who = r.authors.length ? endWith(chicagoAuthors(r.authors, lang)) : "";
  const year = endWith(r.year ?? TERMS[lang].nd);
  const title = headline(r.title);
  const out: Run[] = [{ t: [who, year].filter(Boolean).join(" ") + " " }];
  const url = link(r);
  if (r.type === "article") {
    out.push({ t: `“${endWith(title)}” ` });
    if (r.container) out.push({ t: r.container, i: true });
    const vol = r.volume ? ` ${r.volume}` : "";
    const issue = r.issue ? ` (${r.issue})` : "";
    const pages = r.pages ? `: ${pageRange(r.pages, "chicago")}` : "";
    out.push({ t: `${vol}${issue}${pages}.` });
  } else if (r.type === "chapter") {
    out.push({ t: `“${endWith(title)}” ${TERMS[lang].in} ` });
    if (r.container) out.push({ t: r.container, i: true });
    if (r.editors?.length) out.push({ t: `, ${TERMS[lang].ed} ${r.editors.map(directName).join(", ")}` });
    out.push({ t: r.pages ? `, ${pageRange(r.pages, "chicago")}.` : "." });
    if (r.publisher) out.push({ t: ` ${endWith(r.publisher)}` });
  } else {
    out.push({ t: stripEnd(title), i: true }, { t: "." });
    if (r.publisher) out.push({ t: ` ${endWith(r.publisher)}` });
  }
  if (url) out.push({ t: ` ${endWith(url)}` });
  return tidy(out);
}

function mla(r: CitationRecord, lang: CitationLang): Run[] {
  const T = TERMS[lang];
  const who = r.authors.length ? endWith(mlaAuthors(r.authors, lang)) : "";
  const title = headline(r.title);
  const out: Run[] = [];
  if (who) out.push({ t: `${who} ` });
  const tail: string[] = [];
  const url = link(r);
  if (r.type === "article" || r.type === "chapter") {
    out.push({ t: `“${endWith(title)}” ` });
    if (r.container) out.push({ t: r.container, i: true });
    if (r.type === "chapter" && r.editors?.length) tail.push(`${T.ed} ${r.editors.map(directName).join(", ")}`);
    if (r.volume) tail.push(`${T.vol} ${r.volume}`);
    if (r.issue) tail.push(`${T.no} ${r.issue}`);
    if (r.type === "chapter" && r.publisher) tail.push(mlaPublisher(r.publisher));
    if (r.year) tail.push(r.year);
    if (r.pages) tail.push(`${/[-–]/.test(r.pages) ? T.pp : T.p} ${pageRange(r.pages, "mla")}`);
  } else {
    out.push({ t: stripEnd(title), i: true });
    if (r.publisher) tail.push(mlaPublisher(r.publisher));
    if (r.year) tail.push(r.year);
  }
  if (url) tail.push(url.replace(/^https?:\/\/(?!doi\.org)/, ""));
  const rest = tail.join(", ");
  out.push({ t: rest ? `${r.type === "book" || !r.container ? ". " : ", "}${endWith(rest)}` : "." });
  return tidy(out);
}

/** Joins neighbouring runs of the same kind and drops empty ones. */
function tidy(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out[out.length - 1];
    if (last && !!last.i === !!r.i) last.t += r.t;
    else out.push({ ...r });
  }
  if (out.length) out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, "");
  return out;
}

export function formatReference(r: CitationRecord, style: CitationStyle, lang: CitationLang = "en"): Run[] {
  return style === "apa" ? apa(r, lang) : style === "chicago" ? chicago(r, lang) : mla(r, lang);
}

/** The parenthetical citation: (Austen, 1813) · (Austen 1813) · (Austen). */
export function formatInText(r: CitationRecord, style: CitationStyle, lang: CitationLang = "en", page?: string): string {
  const T = TERMS[lang];
  const fam = r.authors.map((a) => a.family);
  const word = style === "apa" ? "amp" : "and";
  const who =
    fam.length === 0
      ? plainTitle(r.title)
      : fam.length === 1
        ? fam[0]
        : fam.length === 2
          ? `${fam[0]} ${and(lang, fam[1], word)}`
          : `${fam[0]} ${T.etAl}`;
  const year = r.year ?? T.nd;
  if (style === "apa") return `(${who}, ${year}${page ? `, ${/[-–]/.test(page) ? T.pp : T.p} ${page}` : ""})`;
  if (style === "chicago") return `(${who} ${year}${page ? `, ${page}` : ""})`;
  return `(${who}${page ? ` ${page}` : ""})`;
}

export const runsToMarkdown = (runs: readonly Run[]) => runs.map((r) => (r.i ? `*${r.t}*` : r.t)).join("");
export const runsToText = (runs: readonly Run[]) => runs.map((r) => r.t).join("");

// ── From BibTeX ─────────────────────────────────────────────────────────

/** "Last, First and First Last and {World Health Organization}". */
export function parseNames(raw: string): Name[] {
  return raw
    .split(/\s+and\s+(?![^{]*\})/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): Name => {
      if (/^\{.*\}$/.test(s)) return { family: s.slice(1, -1) };
      const parts = s.split(",").map((p) => p.trim());
      if (parts.length === 3) return { family: plainTitle(parts[0]), suffix: parts[1], given: parts[2] };
      if (parts.length === 2) return { family: plainTitle(parts[0]), given: parts[1] || undefined };
      const words = s.split(/\s+/);
      // "Ludwig van Beethoven": lowercase particles start the family name.
      let i = words.length - 1;
      while (i > 0 && /^\p{Ll}/u.test(words[i - 1])) i--;
      return { family: plainTitle(words.slice(i).join(" ")), given: words.slice(0, i).join(" ") || undefined };
    });
}

const TYPE: Record<string, CitationRecord["type"]> = {
  book: "book", article: "article", incollection: "chapter", inbook: "chapter", inproceedings: "chapter", conference: "chapter",
  phdthesis: "thesis", mastersthesis: "thesis", techreport: "report", online: "web", misc: "misc",
};

/** A BibTeX entry as a citation record (`--` → en dash, braces kept for sentence case). */
export function recordFromBibtex(e: BibEntry): CitationRecord {
  const f = e.fields;
  const german = /^(german|ngerman|de)/i.test(f.langid ?? f.language ?? "");
  const title = f.title ?? "";
  return {
    type: TYPE[e.type] ?? "misc",
    authors: f.author ? parseNames(f.author) : [],
    editors: f.editor ? parseNames(f.editor) : undefined,
    year: f.year || (f.date ? f.date.slice(0, 4) : undefined),
    title,
    // German capitalizes nouns: no sentence case.
    titleSentence: german ? plainTitle(title) : undefined,
    container: plainTitle(f.journal ?? f.booktitle ?? f.journaltitle ?? "") || undefined,
    publisher: plainTitle(f.publisher ?? f.school ?? f.institution ?? "") || undefined,
    volume: f.volume,
    issue: f.number ?? f.issue,
    pages: f.pages?.replace(/\s*-{1,2}\s*/g, "–"),
    doi: f.doi,
    url: f.url,
    edition: f.edition,
  };
}
