/**
 * Plan W4.21 — the screen-reader journey of W1.23 as data, for Guidepup.
 *
 * Ten tasks of the Hebrew protocol (editor/screen-reader-protocol): each is
 * a few keyboard actions and the Hebrew the reader must say while they
 * happen. The same tasks run under VoiceOver (macOS, Safari / WebKit) and
 * NVDA (Windows, Chrome / Firefox): only the reader's own navigation keys
 * differ, and those are in the spec files. A task passes when every
 * expected phrase appears in what the reader spoke during that task.
 *
 * Expected text is matched as a substring after collapsing whitespace, and
 * either alternative of a `[a, b]` pair counts: VoiceOver and NVDA name the
 * same role differently ("כותרת רמה 1" / "כותרת 1").
 */

export type Key = string;

export interface Task {
  id: number;
  /** The protocol step, in Hebrew, as written in the docs. */
  title: string;
  /** Keys pressed in the page, in order (Playwright key names). */
  keys?: Key[];
  /** Text typed in the page. */
  type?: string;
  /** Reader navigation between the keys: "next" moves the reader's cursor one item. */
  readerNext?: number;
  /** Phrases the reader must speak; an array inside means "one of these". */
  expect: Array<string | string[]>;
}

/** The note the journey starts from (set before the page loads). */
export const JOURNEY_NOTE = ["# תוכנית", "", "פסקה ראשונה עם מילה English אחת.", "", "- [ ] לקנות חלב", ""].join("\n");

export const TASKS: Task[] = [
  { id: 1, title: "פתיחה: שם הדף ושם העורך נקראים", expect: ["Lumen"] },
  { id: 2, title: "קישור הדילוג: Tab פעם אחת", keys: ["Tab"], expect: ["דילוג לתוכן הראשי"] },
  { id: 3, title: "כתיבה: טקסט עברי נקרא כשהוא מוקלד", keys: ["Enter", "Control+End", "Enter"], type: "שורה חדשה", expect: ["שורה חדשה"] },
  { id: 4, title: "מבנה: הכותרת נקראת עם הרמה שלה", keys: ["Control+Home"], expect: [["כותרת רמה 1", "כותרת 1", "heading level 1"], "תוכנית"] },
  { id: 5, title: "משימה: מצב תיבת הסימון נקרא", keys: ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown"], expect: ["לקנות חלב"] },
  { id: 6, title: "פלטת הפקודות: שם הדיאלוג ושדה החיפוש", keys: ["Control+k"], expect: ["הקלד פקודה, או חפש"] },
  { id: 7, title: "פלטת הפקודות: כל פקודה נקראת בחצים", keys: ["ArrowDown", "ArrowDown"], expect: [["אפשרות", "option"]] },
  { id: 8, title: "דיאלוג: Escape סוגר והפוקוס חוזר לעורך", keys: ["Escape", "Control+/"], expect: ["קיצורי מקלדת"] },
  { id: 9, title: "דיאלוג: Escape סוגר את קיצורי המקלדת", keys: ["Escape"], expect: [["עורך", "editor", "תוכנית"]] },
  { id: 10, title: "כיוון מעורב: שורה עם מילה באנגלית נקראת בסדר הנכון", keys: ["Control+Home", "ArrowDown", "ArrowDown"], expect: ["פסקה ראשונה עם מילה", "English", "אחת"] },
];

/** Collapse whitespace and strip direction marks, so a phrase matches however the reader spaced it. */
export function normalizeSpoken(s: string): string {
  return s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
}

/** Which expected phrases were not spoken (empty = the task passed). */
export function missing(task: Task, spoken: string[]): string[] {
  const all = normalizeSpoken(spoken.join(" | "));
  return task.expect
    .filter((e) => !(Array.isArray(e) ? e : [e]).some((alt) => all.includes(normalizeSpoken(alt))))
    .map((e) => (Array.isArray(e) ? e.join(" / ") : e));
}

/** One row for the protocol's results table (docs/…/screen-reader-protocol.md). */
export function resultRow(date: string, version: string, setup: string, results: Array<{ id: number; missing: string[] }>): string {
  const passed = results.filter((r) => r.missing.length === 0).map((r) => r.id);
  const blockers = results.filter((r) => r.missing.length > 0).map((r) => `${r.id}: ${r.missing.join(", ")}`);
  return `| ${date} | ${version} | ${setup} (Guidepup) | ${passed.length}/${results.length} (${passed.join(", ")}) | ${blockers.join("; ") || "—"} |`;
}
