/**
 * Jewish-source references (plan W5.1): "בראשית א:א", "ב״ר א, א",
 * "שמות כ׳ ג׳", "Gen. 1:1-3", "ברכות ב.", "Berakhot 2a", "[[בראשית:א:א]]"…
 * parsed into one canonical reference — Sefaria's title and address —
 * plus its Hebrew display form and its sefaria.org link.
 *
 * Numbers can be Hebrew numerals (א, י״ט, קי״ט, with or without geresh or
 * gershayim; ט״ו and ט״ז are 15 and 16) or digits. A Talmud folio side is
 * "a"/"b", "ע״א"/"ע״ב", "עמוד א", or the classic dot and colon (ב. / ב:).
 */

import { ALL_BOOKS, mishnahOf, type Book } from "./books";

export interface SourceRef {
  book: Book;
  /** Chapter (perek, midrash section), or the Talmud folio (daf). */
  chapter: number;
  /** Verse / mishnah / paragraph; absent for a whole chapter. */
  verse?: number;
  /** Last verse of a range. */
  toVerse?: number;
  /** Talmud folio side. */
  side?: "a" | "b";
  /** Sefaria's reference: "Genesis 1:1", "Bereshit Rabbah 1:1", "Berakhot 2a". */
  tref: string;
  /** Hebrew display: "בראשית א׳:א׳", "ברכות ב׳ ע״א". */
  he: string;
  /** https://www.sefaria.org/Genesis.1.1 */
  url: string;
  /** A stable key for the verse (graph node, notes index): "Genesis.1.1". */
  key: string;
}

// ── Normalization ───────────────────────────────────────────────────────

/** Geresh → ', gershayim → ", dashes → -, spaces collapsed, Latin lower-cased. */
export function normalizeRef(s: string): string {
  return s
    .replace(/[\u05f3\u2018\u2019`\u00b4]/g, "'")
    .replace(/[\u05f4\u201c\u201d\u201e]/g, '"')
    .replace(/[\u2010-\u2015\u05be]/g, "-")
    .replace(/[\u0591-\u05c7]/g, "") // points and cantillation
    .replace(/\u00a0|_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const aliasKey = (s: string) => normalizeRef(s).replace(/\.(?=\s|$)/g, "").replace(/\s+/g, " ");

interface Alias {
  key: string;
  book: Book;
}

let ALIASES: Alias[] | null = null;
function aliases(): Alias[] {
  if (ALIASES) return ALIASES;
  const out: Alias[] = [];
  for (const book of ALL_BOOKS) for (const name of [book.en, book.he, ...book.aliases]) out.push({ key: aliasKey(name), book });
  // Longest first: "שמות רבה" before "שמות", "Mishnah Berakhot" before "Berakhot".
  out.sort((a, b) => b.key.length - a.key.length);
  ALIASES = out;
  return out;
}

// ── Numbers ─────────────────────────────────────────────────────────────

const LETTER_VALUE: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400,
};

/** A Hebrew numeral ("קי"ט", "כ'", "טו") or digits, as a number; null when it is neither. */
export function parseNumber(token: string): number | null {
  const t = token.replace(/['"\u05f3\u05f4]/g, "");
  if (/^\d+$/.test(t)) return Number(t);
  if (!/^[א-ת]+$/.test(t) || t.length > 5) return null;
  // A numeral's letters go from the largest value down (קי״ט), except ט״ו / ט״ז:
  // so a word such as "ברא" is not read as 203.
  const values = Array.from(t, (ch) => LETTER_VALUE[ch] ?? NaN);
  if (values.some((v) => !Number.isFinite(v))) return null;
  const tail = t.slice(-2);
  const ordered = values.every((v, i) => i === 0 || v <= values[i - 1] || ((tail === "טו" || tail === "טז") && i === values.length - 1));
  if (!ordered) return null;
  const n = values.reduce((a, b) => a + b, 0);
  return n > 0 ? n : null;
}

const ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const HUNDREDS = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];

/** A number as a Hebrew numeral with geresh or gershayim: 1 → א׳, 15 → ט״ו, 119 → קי״ט. */
export function hebrewNumeral(n: number): string {
  if (n <= 0 || n >= 1000) return String(n);
  let s = HUNDREDS[Math.floor(n / 100)];
  const rest = n % 100;
  if (rest === 15) s += "טו";
  else if (rest === 16) s += "טז";
  else s += TENS[Math.floor(rest / 10)] + ONES[rest % 10];
  return s.length === 1 ? `${s}\u05f3` : `${s.slice(0, -1)}\u05f4${s.slice(-1)}`;
}

// ── Parsing ─────────────────────────────────────────────────────────────

const FILLER = /\b(?:chapter|chap|ch|verse|vs|v|daf|folio|mishnah|mishna|halakhah)\b\.?|(?:^|\s)(?:פרק|פסוק|פסוקים|משנה|הלכה|דף|סימן)(?=\s|$)/g;

function sideOf(word: string): "a" | "b" | null {
  const w = word.replace(/['"]/g, "");
  if (w === "עא" || w === "a" || w === "א") return "a";
  if (w === "עב" || w === "b" || w === "ב") return "b";
  return null;
}

function build(book: Book, chapter: number, verse?: number, toVerse?: number, side?: "a" | "b"): SourceRef {
  const dotted = book.en.replace(/ /g, "_");
  if (book.kind === "talmud") {
    const s = side ?? "a";
    return {
      book,
      chapter,
      side: s,
      tref: `${book.en} ${chapter}${s}`,
      he: `${book.he} ${hebrewNumeral(chapter)} ${s === "a" ? "ע\u05f4א" : "ע\u05f4ב"}`,
      url: `https://www.sefaria.org/${dotted}.${chapter}${s}`,
      key: `${dotted}.${chapter}${s}`,
    };
  }
  const range = verse !== undefined && toVerse !== undefined && toVerse > verse ? toVerse : undefined;
  const tref = verse === undefined ? `${book.en} ${chapter}` : `${book.en} ${chapter}:${verse}${range ? `-${range}` : ""}`;
  const he = verse === undefined ? `${book.he} ${hebrewNumeral(chapter)}` : `${book.he} ${hebrewNumeral(chapter)}:${hebrewNumeral(verse)}${range ? `-${hebrewNumeral(range)}` : ""}`;
  const path = verse === undefined ? `${chapter}` : `${chapter}.${verse}${range ? `-${range}` : ""}`;
  return { book, chapter, ...(verse !== undefined ? { verse } : {}), ...(range ? { toVerse: range } : {}), tref, he, url: `https://www.sefaria.org/${dotted}.${path}`, key: `${dotted}.${verse === undefined ? chapter : `${chapter}.${verse}`}` };
}

/**
 * Parse one reference. Accepts a bare reference, a wiki link
 * ("[[בראשית:א:א]]", "[[Genesis 1:1|the verse]]") or a reference with
 * "פרק … פסוק …" words. Returns null when it is not one.
 */
export function parseSourceRef(input: string): SourceRef | null {
  let s = input.trim();
  const wiki = /^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(s);
  if (wiki) s = wiki[1];
  s = normalizeRef(s);
  // A book name followed by its address.
  const al = aliases();
  let found: Alias | null = null;
  let rest = "";
  const bookPart = s.replace(/\.(?=\s)/g, "");
  for (const a of al) {
    if (!bookPart.startsWith(a.key)) continue;
    const after = bookPart.slice(a.key.length);
    if (after && !/^[\s:,.\-]/.test(after) && !/^\d/.test(after)) continue;
    found = a;
    rest = after.replace(/^[\s:,]+/, "");
    break;
  }
  if (!found) return null;
  const { book } = found;
  rest = rest.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (!rest) return null;

  if (book.kind === "talmud") {
    const folio = parseFolio(book, rest);
    if (folio) return folio;
    // "ברכות א:א" — chapter and mishnah: the Mishnah tractate.
    const m = mishnahOf(book);
    return m ? parseChapterVerse(m, rest) : null;
  }
  return parseChapterVerse(book, rest);
}

function parseFolio(book: Book, rest: string): SourceRef | null {
  {
    // 2a, 2b, 2a:5 / ב. ב: / ב ע"א / ב עמוד א
    let m = /^(\d+)\s*([ab])\b/.exec(rest);
    if (m) return build(book, Number(m[1]), undefined, undefined, m[2] as "a" | "b");
    m = /^([א-ת'"]+|\d+)\s*([.:])$/.exec(rest);
    if (m) {
      const daf = parseNumber(m[1]);
      return daf ? build(book, daf, undefined, undefined, m[2] === "." ? "a" : "b") : null;
    }
    m = /^([א-ת'"]+|\d+)(?:\s+(?:עמוד|עמ'?|ע'?))?\s*([א-ת'"]+|[ab])?$/.exec(rest);
    if (m) {
      const daf = parseNumber(m[1]);
      const side = m[2] ? sideOf(m[2]) : "a";
      return daf && side ? build(book, daf, undefined, undefined, side) : null;
    }
    return null;
  }
}

function parseChapterVerse(book: Book, rest: string): SourceRef | null {
  // chapter[:verse][-toVerse], separated by : , . space
  const tokens = rest.split(/\s*-\s*/);
  const head = tokens[0].split(/[\s:,.]+/).filter(Boolean);
  if (head.length < 1 || head.length > 2) return null;
  const chapter = parseNumber(head[0]);
  if (!chapter) return null;
  const verse = head[1] !== undefined ? parseNumber(head[1]) : undefined;
  if (head[1] !== undefined && !verse) return null;
  let toVerse: number | undefined;
  if (tokens[1] !== undefined) {
    const tail = tokens[1].split(/[\s:,.]+/).filter(Boolean);
    const last = parseNumber(tail[tail.length - 1] ?? "");
    if (!last) return null;
    toVerse = last;
  }
  return build(book, chapter, verse ?? undefined, toVerse);
}

/** Wiki links in a note that are source references, by verse key (for the notes index and the graph). */
export function sourceRefsIn(markdown: string): SourceRef[] {
  const out: SourceRef[] = [];
  for (const m of markdown.matchAll(/!?\[\[[^\]\n]+\]\]/g)) {
    const r = parseSourceRef(m[0]);
    if (r) out.push(r);
  }
  for (const m of markdown.matchAll(/https:\/\/www\.sefaria\.org\/([A-Za-z_]+)\.(\d+[ab]?)(?:\.(\d+))?/g)) {
    const r = parseSourceRef(`${m[1].replace(/_/g, " ")} ${m[2]}${m[3] ? `:${m[3]}` : ""}`);
    if (r) out.push(r);
  }
  return out;
}
