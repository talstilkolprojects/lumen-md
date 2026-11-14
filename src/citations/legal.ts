/**
 * Israeli legal citation (plan W5.2): כללי האזכור האחיד בכתיבה המשפטית,
 * third edition (Tel Aviv University Faculty of Law, February 2021), for
 * rulings, laws, regulations, bills, books and law-review articles. Our
 * own templates, as for the academic styles (no citeproc; decision 15.10).
 *
 * The rules' own examples (their summary "כללים מרכזיים", 2021) are the
 * golden cases in src/__tests__/legalCitations.test.ts:
 *
 *   בג"ץ 7/48 אל-כרבוטלי נ' שר-הבטחון, פ"ד ב 5, פס' 14 (1949).
 *   ת"פ (מקומיים י-ם) 2857/85 מדינת ישראל נ' אורנן, פ"מ התשמ"ז(ג) 334 (1987).
 *   ת"כ (תחרות) 745-07-18 בנק מזרחי טפחות בע"מ נ' הממונה על התחרות (נבו 28.11.2019).
 *   חוק איסור נהיגה ברכב בחוף הים, התשנ"ז–1997, ס"ח 84.
 *   הצעת חוק ההתיישנות, התשס"ד–2004, ה"ח הממשלה 611.
 *   אהרן ברק פרשנות במשפט כרך שני: פרשנות החקיקה (1993).
 *   יפה זילברשץ "על חופש הביטוי המסחרי" משפט וממשל ג 509, חלקים ד(3)-(4) (1996).
 *
 * Abbreviations are written with an ASCII double quote (פ"ד, בג"ץ) and an
 * apostrophe (נ', ס'), as the rules print them; a Hebrew year and its
 * Gregorian year are joined by an en dash (התשנ"ז–1997).
 */

export interface RulingSource {
  kind: "ruling";
  /** The type of proceeding: ע"א, בג"ץ, ת"א … */
  proceeding: string;
  /** The court, for every court but the Supreme Court: "מחוזי ת"א", "מקומיים י-ם". */
  court?: string;
  number: string;
  parties: [string, string];
  /** A printed report: פ"ד ב 5; פ"מ התשמ"ז(ג) 334. */
  reporter?: { series: string; volume: string; page: string };
  /** An unpublished ruling: the database and the date of the decision. */
  database?: { name: string; date: string };
  /** Year of a printed ruling. */
  year?: string;
  /** Paragraphs ("14", "35–36") and, optionally, whose opinion ("הנשיאה (בדימ') ביניש"). */
  pinpoint?: { paras: string; judge?: string };
}

export interface LegislationSource {
  kind: "law" | "regulation" | "bill";
  name: string;
  /** "התשנ"ז"; leave empty for a Basic Law cited by its collection year. */
  hebrewYear?: string;
  year?: string;
  /** ס"ח, ק"ת, ה"ח הממשלה, ה"ח הכנסת … (defaults by kind). */
  collection?: string;
  /** The collection's year, when it is not the law's own year: ס"ח התשס"א. */
  collectionYear?: string;
  page: string;
  /** The page cited in the collection, after the first page. */
  pinpointPage?: string;
  /** A section: "ס' 10 ל…". */
  section?: string;
}

export interface BookSource {
  kind: "book";
  authors: string[];
  title: string;
  volume?: string;
  pinpoint?: string;
  edition?: string;
  editor?: string;
  translator?: string;
  year: string;
}

export interface ArticleSource {
  kind: "article";
  authors: string[];
  title: string;
  journal: string;
  volume: string;
  /** Only when every issue starts again at page 1. */
  issue?: string;
  page: string;
  pinpoint?: string;
  year: string;
}

export type LegalSource = RulingSource | LegislationSource | BookSource | ArticleSource;

const HEBREW_START = /^[א-ת]/;

/** Hebrew "and": attached to a Hebrew word (ובני שגיא), with a hyphen before anything else (ו-Smith). */
export function joinNames(names: readonly string[]): string {
  const ns = names.map((n) => n.trim()).filter(Boolean);
  if (ns.length < 2) return ns[0] ?? "";
  const last = ns[ns.length - 1];
  const and = HEBREW_START.test(last) ? `ו${last}` : `ו-${last}`;
  return `${ns.slice(0, -1).join(", ")} ${and}`;
}

/** A date as the rules write it: 28.11.2019, 22.5.2012 (no leading zeros). Accepts YYYY-MM-DD or d.m.yyyy. */
export function ruleDate(date: string): string {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  if (iso) return `${Number(iso[3])}.${Number(iso[2])}.${iso[1]}`;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(date.trim());
  return dmy ? `${Number(dmy[1])}.${Number(dmy[2])}.${dmy[3]}` : date.trim();
}

const ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const HUNDREDS = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];

/** A Hebrew year as legislation writes it: 5757 → התשנ"ז (with the ה of the thousands). */
export function hebrewYearText(year: number): string {
  let n = year % 1000;
  let s = HUNDREDS[Math.floor(n / 100)];
  n %= 100;
  // 15 and 16 are written ט"ו and ט"ז.
  if (n === 15) s += "טו";
  else if (n === 16) s += "טז";
  else s += TENS[Math.floor(n / 10)] + ONES[n % 10];
  return `ה${s.length > 1 ? `${s.slice(0, -1)}"${s.slice(-1)}` : `${s}'`}`;
}

/** The Hebrew year of a date (YYYY-MM-DD), from the browser's Hebrew calendar: 1997-03-05 → התשנ"ז. */
export function hebrewYearOfDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  try {
    const y = new Intl.DateTimeFormat("en-u-ca-hebrew", { year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)));
    const n = Number(/\d{4}/.exec(y)?.[0]);
    return n ? hebrewYearText(n) : null;
  } catch {
    return null;
  }
}

const COLLECTION: Record<LegislationSource["kind"], string> = { law: 'ס"ח', regulation: 'ק"ת', bill: 'ה"ח הממשלה' };

function ruling(s: RulingSource): string {
  const head = `${s.proceeding}${s.court ? ` (${s.court})` : ""} ${s.number} ${s.parties[0]} נ' ${s.parties[1]}`;
  const pin = s.pinpoint?.paras ? `פס' ${s.pinpoint.paras}${s.pinpoint.judge ? ` לפסק הדין של ${s.pinpoint.judge}` : ""}` : "";
  if (s.reporter) {
    const rep = `${s.reporter.series} ${s.reporter.volume} ${s.reporter.page}`;
    return `${head}, ${rep}${pin ? `, ${pin}` : ""}${s.year ? ` (${s.year})` : ""}.`;
  }
  const db = s.database ? ` (${s.database.name} ${ruleDate(s.database.date)})` : "";
  return `${head}${pin ? `, ${pin}` : ""}${db}.`;
}

function legislation(s: LegislationSource): string {
  const name = s.section ? `ס' ${s.section} ל${s.name}` : s.name;
  const years = s.hebrewYear ? `, ${s.hebrewYear}${s.year ? `–${s.year}` : ""}` : "";
  const coll = s.collection ?? COLLECTION[s.kind];
  const collYear = s.collectionYear && s.collectionYear !== s.hebrewYear ? ` ${s.collectionYear}` : "";
  return `${name}${years}, ${coll}${collYear} ${s.page}${s.pinpointPage ? `, ${s.pinpointPage}` : ""}.`;
}

function book(s: BookSource): string {
  const paren = [s.edition, s.editor, s.translator, s.year].filter(Boolean).join(" ");
  return `${joinNames(s.authors)} ${s.title}${s.volume ? ` ${s.volume}` : ""}${s.pinpoint ? ` ${s.pinpoint}` : ""} (${paren}).`;
}

function article(s: ArticleSource): string {
  return `${joinNames(s.authors)} "${s.title}" ${s.journal} ${s.volume}${s.issue ? `(${s.issue})` : ""} ${s.page}${s.pinpoint ? `, ${s.pinpoint}` : ""} (${s.year}).`;
}

/** One source as a citation in a footnote, by the uniform citation rules. */
export function formatLegal(s: LegalSource): string {
  switch (s.kind) {
    case "ruling":
      return ruling(s);
    case "book":
      return book(s);
    case "article":
      return article(s);
    default:
      return legislation(s);
  }
}

/* ─── Case numbers in text ───────────────────────────────────────────── */

/** Types of proceeding the detector knows (Supreme Court and lower courts, civil, criminal, administrative, labour, family). */
export const PROCEEDINGS = [
  'בג"ץ', 'בג"צ', 'דנג"ץ', 'ע"א', 'רע"א', 'דנ"א', 'ע"פ', 'רע"פ', 'דנ"פ', 'בש"פ', 'עע"מ', 'בר"מ', 'עת"מ', 'עמ"ן', 'ע"מ',
  'ת"א', 'ת"פ', 'ה"פ', 'ת"צ', 'ת"ק', 'ת"כ', 'תמ"ש', 'עמ"ש', 'רמ"ש', 'ע"ע', 'סע"ש', 'ע"ב', 'בע"ח', 'ע"ר', 'ב"ש',
] as const;

export interface CaseNumberMatch {
  proceeding: string;
  court?: string;
  number: string;
  from: number;
  to: number;
}

const Q = `["״”]`;
const proc = PROCEEDINGS.map((p) => p.replace('"', Q)).sort((a, b) => b.length - a.length).join("|");
// why: Hebrew attaches prefix letters to the abbreviation ("בע"א", "ובבג"ץ"); they are not part of the match.
const CASE_RE = new RegExp(`(?<![\\u05D0-\\u05EA])([ובלכמשה]{0,3}?)(${proc})(?:\\s*\\(([^()\\n]{1,40})\\))?\\s+(\\d{1,6}(?:/\\d{2,4}|-\\d{2}-\\d{2}))(?![\\d/-])`, "g");

/** Case numbers written in the text: "ע"א 1234/05", "ת"א (מחוזי ת"א) 1234-05-19", with ״ or ". */
export function findCaseNumbers(text: string): CaseNumberMatch[] {
  const out: CaseNumberMatch[] = [];
  for (const m of text.matchAll(CASE_RE)) {
    const from = m.index! + m[1].length;
    out.push({ proceeding: m[2].replace(/[״”]/g, '"'), court: m[3]?.trim().replace(/[״”]/g, '"') || undefined, number: m[4], from, to: m.index! + m[0].length });
  }
  return out;
}

/** The case number at (or around) `pos` in `text`. */
export function caseNumberAt(text: string, pos: number): CaseNumberMatch | null {
  return findCaseNumbers(text).find((m) => pos >= m.from && pos <= m.to) ?? null;
}

/** A ruling to start the picker from: the number found, the rest left for the person (the parties, the database date). */
export function rulingFromMatch(m: CaseNumberMatch): RulingSource {
  return { kind: "ruling", proceeding: m.proceeding, court: m.court, number: m.number, parties: ["", ""], database: { name: "נבו", date: "" } };
}
