/**
 * Israeli academic submission templates for the Word export (plan W5.16).
 *
 * Each profile is the written formatting rules of one institution's
 * published guideline (the source is in `source`), turned into the numbers
 * the DOCX writer needs: page margins, the Hebrew and Latin typefaces, the
 * size, the line spacing, how the front matter is numbered and what the
 * title page shows. Where a guideline is silent the profile keeps Word's
 * default and says so in `notes`, so nothing here is invented.
 *
 * Pure data and pure functions: no DOM, no i18n (the title page is part of
 * the document, so its labels follow the document's language, not the UI's).
 */

/** Page-number format for a section: Word's ST_NumberFormat values. */
export type PageNumberFormat = "none" | "decimal" | "hebrew1" | "lowerRoman";

export type AcademicTemplateId = "huji" | "biu" | "haifa" | "openu" | "tau";

export interface AcademicTemplate {
  id: AcademicTemplateId;
  /** The institution as it appears on the title page. */
  institution: { he: string; en: string };
  /** What the guideline covers (e.g. a seminar paper in one faculty). */
  scope: { he: string; en: string };
  /** The published guideline the numbers come from. */
  source: string;
  /** Margins in centimetres, physical sides of the page. */
  marginsCm: { top: number; bottom: number; right: number; left: number };
  /** Typeface for Hebrew (and Arabic) text: Word's complex-script font. */
  hebrewFont: string;
  /** Typeface for Latin text. */
  latinFont: string;
  /** Body size in points. */
  sizePt: number;
  /** Footnote size in points. */
  footnoteSizePt: number;
  /** Body line spacing as a multiple (1.5 = one and a half lines). */
  lineSpacing: number;
  /** Justify body paragraphs to both margins. */
  justify: boolean;
  /** Indent the first line of each body paragraph, in centimetres (0 = none). */
  firstLineIndentCm: number;
  /** Each top-level chapter starts on a new page. */
  chapterOnNewPage: boolean;
  /** How the front matter (table of contents) is numbered by default. */
  frontNumbering: PageNumberFormat;
  /** Where the page number sits. */
  pageNumberAt: "bottom-center";
  /** Rules the profile could not take from the guideline, in English. */
  notes: string[];
}

const DEFAULT_MARGIN_CM = 2.54; // Word's own default, kept where a guideline gives none

export const ACADEMIC_TEMPLATES: readonly AcademicTemplate[] = [
  {
    id: "huji",
    institution: { he: "האוניברסיטה העברית בירושלים", en: "The Hebrew University of Jerusalem" },
    scope: { he: "עבודות בפקולטה למדעי הרוח (ספרות כללית והשוואתית)", en: "Papers in the Faculty of Humanities (General and Comparative Literature)" },
    source: "https://complit.huji.ac.il/sites/default/files/complit/files/hnkhyvt_mqvtsrvt_lhgsht_bvdvt_0.pdf",
    marginsCm: { top: DEFAULT_MARGIN_CM, bottom: DEFAULT_MARGIN_CM, right: DEFAULT_MARGIN_CM, left: DEFAULT_MARGIN_CM },
    hebrewFont: "David",
    latinFont: "Times New Roman",
    sizePt: 11,
    footnoteSizePt: 9,
    lineSpacing: 2,
    justify: true,
    firstLineIndentCm: 1.25,
    chapterOnNewPage: false,
    frontNumbering: "none",
    pageNumberAt: "bottom-center",
    notes: ["Margins: the guideline says only not to reduce them, so Word's default 2.54 cm is kept.", "Footnote size is in a separate guideline; 9 pt is two points below the body."],
  },
  {
    id: "biu",
    institution: { he: "אוניברסיטת בר־אילן", en: "Bar-Ilan University" },
    scope: { he: "עבודה סמינריונית (המחלקה למדע המדינה; ספריות בר־אילן)", en: "Seminar paper (Political Studies; Bar-Ilan libraries)" },
    source: "https://politics.biu.ac.il/files/politics/shared/hnkhyvt_lktybt_bvdh_smynryvnyt_mkhqryt.pdf",
    marginsCm: { top: 2.5, bottom: 2.5, right: 2.5, left: 2.5 },
    hebrewFont: "David",
    latinFont: "Times New Roman",
    sizePt: 12,
    footnoteSizePt: 10,
    lineSpacing: 1.5,
    justify: true,
    firstLineIndentCm: 0,
    chapterOnNewPage: true,
    frontNumbering: "none",
    pageNumberAt: "bottom-center",
    notes: ["Font and size from the Bar-Ilan libraries guideline (David 12, one and a half lines): https://lib.biu.ac.il/files/libraries/shared/hnkhyvt_lktybt_bvdvt_tshp.pdf"],
  },
  {
    id: "haifa",
    institution: { he: "אוניברסיטת חיפה", en: "University of Haifa" },
    scope: { he: "עבודת גמר לתואר שני (בית הספר לעבודה סוציאלית)", en: "Master's thesis (School of Social Work)" },
    source: "https://sw2.haifa.ac.il/images/stories/MA/hanchiot_tiza_072024.pdf",
    marginsCm: { top: 2, bottom: 2, right: 3, left: 2 },
    hebrewFont: "David",
    latinFont: "Times New Roman",
    sizePt: 12,
    footnoteSizePt: 10,
    lineSpacing: 1.5,
    justify: true,
    firstLineIndentCm: 0,
    chapterOnNewPage: true,
    frontNumbering: "none",
    pageNumberAt: "bottom-center",
    notes: ["Citations follow APA 7; footnotes are not addressed, so 10 pt single-spaced is used."],
  },
  {
    id: "openu",
    institution: { he: "האוניברסיטה הפתוחה", en: "The Open University of Israel" },
    scope: { he: "עבודת גמר לתואר שני (היסטוריה)", en: "Master's thesis (History)" },
    source: "https://www.openu.ac.il/Lists/MediaServer_Documents/Academic/History/mahistory/MaThesis.pdf",
    marginsCm: { top: 2, bottom: 2, right: 3, left: 2 },
    hebrewFont: "David",
    latinFont: "Times New Roman",
    sizePt: 12,
    footnoteSizePt: 10,
    lineSpacing: 1.5,
    justify: true,
    firstLineIndentCm: 0,
    chapterOnNewPage: true,
    frontNumbering: "lowerRoman",
    pageNumberAt: "bottom-center",
    notes: ["Front matter in Roman numerals centred at the bottom, the body from 1, as the guideline says."],
  },
  {
    id: "tau",
    institution: { he: "אוניברסיטת תל אביב", en: "Tel Aviv University" },
    scope: { he: "עבודת תזה לתואר שני (הפקולטה לרפואה)", en: "Master's thesis (Faculty of Medicine)" },
    source: "https://en-med.tau.ac.il/Thesis_Guidelines",
    marginsCm: { top: 2.5, bottom: 2.5, right: 2.5, left: 2.5 },
    hebrewFont: "David",
    latinFont: "Times New Roman",
    sizePt: 12,
    footnoteSizePt: 10,
    lineSpacing: 1.5,
    justify: true,
    firstLineIndentCm: 0,
    chapterOnNewPage: true,
    frontNumbering: "none",
    pageNumberAt: "bottom-center",
    notes: ["A4, size 12 and 1.5 spacing are from the guideline; it names no margins or typeface, so 2.5 cm and David are used."],
  },
];

export function academicTemplate(id: string): AcademicTemplate | undefined {
  return ACADEMIC_TEMPLATES.find((t) => t.id === id);
}

/** What the title page shows. Every field is optional; an empty one is left out. */
export interface CoverFields {
  title?: string;
  subtitle?: string;
  faculty?: string;
  department?: string;
  course?: string;
  courseNumber?: string;
  lecturer?: string;
  author?: string;
  studentId?: string;
  date?: string;
}

export const COVER_KEYS: readonly (keyof CoverFields)[] = ["title", "subtitle", "faculty", "department", "course", "courseNumber", "lecturer", "author", "studentId", "date"];

/** Title-page labels in the document's language. */
export const COVER_LABELS: Record<"he" | "en", { course: string; lecturer: string; author: string; studentId: string; date: string; toc: string; tocHint: string }> = {
  he: { course: "קורס", lecturer: "מרצה", author: "מגיש/ה", studentId: "ת״ז", date: "תאריך הגשה", toc: "תוכן עניינים", tocHint: "(ב-Word: לחצו על תוכן העניינים ועל F9 כדי לעדכן את מספרי העמודים)" },
  en: { course: "Course", lecturer: "Lecturer", author: "Submitted by", studentId: "ID", date: "Submission date", toc: "Table of contents", tocHint: "(In Word: click the table of contents and press F9 to update the page numbers)" },
};

/** Frontmatter keys the cover reads, with their Hebrew aliases. */
const FRONTMATTER_ALIASES: Record<string, keyof CoverFields> = {
  title: "title",
  כותרת: "title",
  subtitle: "subtitle",
  "סוג העבודה": "subtitle",
  faculty: "faculty",
  פקולטה: "faculty",
  department: "department",
  חוג: "department",
  מחלקה: "department",
  course: "course",
  קורס: "course",
  course_number: "courseNumber",
  courseNumber: "courseNumber",
  "מספר קורס": "courseNumber",
  lecturer: "lecturer",
  instructor: "lecturer",
  מרצה: "lecturer",
  author: "author",
  מגיש: "author",
  מגישה: "author",
  student_id: "studentId",
  studentId: "studentId",
  "ת.ז": "studentId",
  "ת״ז": "studentId",
  date: "date",
  תאריך: "date",
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split a note into its YAML frontmatter's cover fields and the body. Only
 * flat `key: value` lines are read (the cover needs nothing more); quotes
 * around a value are removed.
 */
export function splitCover(md: string): { cover: CoverFields; body: string; institution?: string } {
  const m = md.match(FRONTMATTER);
  if (!m) return { cover: {}, body: md };
  const cover: CoverFields = {};
  let institution: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([^:#][^:]*?)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    const value = kv[2].replace(/^(["'])(.*)\1$/, "$2");
    if (!value) continue;
    if (kv[1] === "institution" || kv[1] === "מוסד") {
      institution = value;
      continue;
    }
    const key = FRONTMATTER_ALIASES[kv[1]];
    if (key) cover[key] = value;
  }
  return { cover, body: md.slice(m[0].length), institution };
}

/** Headings that open the bibliography: the entries after them get the hanging-indent style. */
export const BIBLIOGRAPHY_HEADING = /^(ביבליוגרפיה|רשימת מקורות|מקורות|רשימה ביבליוגרפית|مراجع|المراجع|References|Bibliography|Works Cited)$/i;

/** Centimetres to twentieths of a point (twips), Word's unit for page geometry. */
export function cmToTwips(cm: number): number {
  return Math.round((cm * 1440) / 2.54);
}

/** A line-spacing multiple to Word's `w:line` (240 = single, `lineRule="auto"`). */
export function lineTwips(multiple: number): number {
  return Math.round(multiple * 240);
}
