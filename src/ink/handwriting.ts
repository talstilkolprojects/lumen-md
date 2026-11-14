/**
 * Hebrew handwriting recognition, measured first (plan W7.11).
 *
 * No open Hebrew handwriting recogniser is usable today (HebHTR reads single
 * words and has no licence; the Groningen work on the Dead Sea Scrolls is far
 * from notes; LightOnOCR-2-1B shows no Hebrew), so this file is the
 * measuring kit and the gate, not a recogniser:
 *
 * - The held-out set: 300 lines from 20 writers, with consent and under
 *   CC BY 4.0, mixing digits and English words (`PROMPTS`, `assignPrompts`).
 *   Writers are collected with the app's own pen (W5.27): each writes their
 *   15 lines as ink blocks under the line's heading, and `itemsFromNote`
 *   reads them back. A part is held out by writer (W6.17's rule: a writer's
 *   hand is in one split only).
 * - Two paths: ink (the pen's strokes in order, `inkSequence`, the input an
 *   online recogniser takes; easier than an image because the writing order
 *   is known) and image (the same ink drawn as a picture, or a photo).
 * - The gate: a path is exposed only at CER ≤ 15% (ink) or ≤ 20% (image) on
 *   the held-out set; the numbers are published either way.
 * - Recognition never leaves the device (an engine on this machine only).
 */
import { parseInk, findInkBlocks, type Ink } from "./inkModel";

export const GATES = { ink: 0.15, image: 0.2 } as const;
export type HandwritingPath = keyof typeof GATES;

/**
 * 60 prompt lines written for this set (CC0): everyday Hebrew, with digits,
 * dates, prices, phone-like numbers and English words inside the line.
 */
export const PROMPTS: readonly string[] = [
  "הפגישה נדחתה ליום שלישי בשעה 10:30",
  "צריך לקנות חלב, לחם ו-12 ביצים",
  "המבחן בסטטיסטיקה יהיה ב-14 בפברואר",
  "לשלוח ל-Dana את הקובץ של ה-budget",
  "הטמפרטורה הגיעה היום ל-38 מעלות",
  "סיכום ההרצאה: שלושה רעיונות מרכזיים",
  "מספר החדר החדש הוא 305 בבניין B",
  "לזכור להחזיר את הספר לספרייה עד יום חמישי",
  "המחיר עלה מ-45 ל-52 שקלים",
  "תרגיל 4 בעמוד 112, סעיפים א עד ג",
  "ה-deadline של הפרויקט הוא סוף החודש",
  "לבדוק את ה-email של המרצה לפני השיעור",
  "יש לי תור לרופא ב-8:15 בבוקר",
  "קראתי שני פרקים מתוך Harry Potter",
  "הרכבת יוצאת מרציף 3 בשעה 17:42",
  "לשאול את יוסי על הנתונים של 2025",
  "המשוואה: x שווה 7 כפול y פחות 3",
  "המתכון דורש 250 גרם קמח וכוס סוכר",
  "ביום ראשון ננקה את המחסן ביחד",
  "הסיסמה החדשה צריכה לפחות 12 תווים",
  "לתקן את ה-bug בטופס ההרשמה",
  "השכירות עולה 4,200 שקלים לחודש",
  "הכנס בתל אביב נפתח ב-9 בבוקר",
  "רעיון למאמר: זיכרון ושינה אצל סטודנטים",
  "לקבוע שיחה עם Google Meet ביום רביעי",
  "בכיתה יש 28 תלמידים ו-2 מורות",
  "הטיסה ל-London נוחתת בחצות",
  "הספר נכתב בשנת 1948 בירושלים",
  "צריך להדפיס 3 עותקים של החוזה",
  "המסקנה: הניסוי הצליח רק בפעם השנייה",
  "השעון מצלצל כל בוקר ב-6:45",
  "לקנות מתנה לאמא, תקציב עד 150",
  "פרק 7 מסביר את חוק ניוטון השני",
  "הקוד נמצא ב-GitHub בתיקייה src",
  "לבקש הארכה של שבוע בעבודה",
  "המרחק מהבית לעבודה הוא 18 קילומטר",
  "בשבת נצא לטיול בגליל העליון",
  "התשלום יבוצע ב-3 תשלומים שווים",
  "לבדוק אם ה-Wi-Fi עובד בחדר הישיבות",
  "הציון הסופי שלי בקורס היה 91",
  "השיר הזה הושמע ברדיו ב-1987",
  "לשים לב: הכתובת היא רחוב הרצל 12",
  "ההרצאה עוסקת ב-machine learning בעברית",
  "המלאי ירד ל-36 יחידות בלבד",
  "להתקשר לחברת החשמל לפני 16:00",
  "האוטובוס האחרון יוצא ב-23:10",
  "בדוח יש טעות בטבלה מספר 2",
  "לקרוא את המאמר של Smith ו-Lee",
  "המשחק נגמר בתוצאה 3 נגד 1",
  "הכיתה עוברת לקומה 4 מחר",
  "תזכורת: לשלם את חשבון המים",
  "הניסוי חוזר 5 פעמים בכל יום",
  "הסרט מתחיל ב-20:30 בקולנוע",
  "לכתוב תודה לצוות של ה-hackathon",
  "המכונית צריכה טיפול של 15,000 קילומטר",
  "השאלה הקשה ביותר הייתה שאלה 6",
  "להוריד את האפליקציה מה-App Store",
  "יום ההולדת של נועה ב-22 ביוני",
  "הקפה בקפיטריה עולה 9 שקלים",
  "סוף סוף סיימתי את הסמינריון",
];

export const WRITERS = 20;
export const LINES_PER_WRITER = 15;

/** Each writer's 15 prompts: every prompt is written by 5 writers, and no writer gets the same set. */
export function assignPrompts(writer: number): number[] {
  if (writer < 1 || writer > WRITERS) throw new Error(`writer ${writer} is not 1..${WRITERS}`);
  return Array.from({ length: LINES_PER_WRITER }, (_, k) => (k * 4 + ((writer - 1) % 4) + Math.floor((writer - 1) / 4) * 12) % PROMPTS.length);
}

/** A writer's collection note: the consent line, then a `## n` heading and the line to write for each of their 15 prompts. */
export function collectionSheet(writer: number): string {
  const lines = [
    `# Handwriting sheet — writer ${writer}`,
    "",
    "> I agree that the lines I write here are published under CC BY 4.0 for measuring handwriting recognition. / אני מסכים/ה שהשורות שאכתוב כאן יפורסמו ב-CC BY 4.0 לצורך מדידת זיהוי כתב יד.",
    "",
  ];
  for (const p of assignPrompts(writer)) lines.push(`## ${p}`, "", `> ${PROMPTS[p]}`, "", "");
  return lines.join("\n");
}

/** W6.17: held-out by writer. Writers 16..20 (75 lines, a quarter) are never committed; their ink goes to the held-out evaluator. */
export const HELD_OUT_WRITERS: readonly number[] = [16, 17, 18, 19, 20];
export const splitOf = (writer: number): "dev" | "heldout" => (HELD_OUT_WRITERS.includes(writer) ? "heldout" : "dev");

export interface HandwritingItem {
  writer: number;
  prompt: number;
  /** What was asked to be written (the reference). */
  text: string;
  ink: Ink;
}

/**
 * A collection note: `## 7` headings (the prompt number, from the writer's
 * sheet), each followed by the ink block the writer drew. Headings without
 * ink are skipped (and listed), so a half-done sheet is still usable.
 */
export function itemsFromNote(writer: number, markdown: string): { items: HandwritingItem[]; missing: number[] } {
  const items: HandwritingItem[] = [];
  const missing: number[] = [];
  const heads = [...markdown.matchAll(/^##\s+(\d+)\s*$/gm)].map((m) => ({ prompt: Number(m[1]), at: m.index ?? 0 }));
  const blocks = findInkBlocks(markdown);
  heads.forEach((h, i) => {
    const end = heads[i + 1]?.at ?? markdown.length;
    const b = blocks.find((x) => x.start > h.at && x.start < end);
    const ink = b ? parseInk(markdown.slice(b.start, b.end)) : null;
    if (!ink || !ink.strokes.length || !(h.prompt >= 0 && h.prompt < PROMPTS.length)) missing.push(h.prompt);
    else items.push({ writer, prompt: h.prompt, text: PROMPTS[h.prompt], ink });
  });
  return { items, missing };
}

/**
 * The pen's strokes as an online recogniser takes them: in writing order,
 * scaled to a height of 1 (x keeps its proportion), origin at the top left,
 * each point `[x, y, pressure]`, strokes kept apart. A Hebrew line is written
 * right to left; the order is the pen's, never re-sorted.
 */
export function inkSequence(ink: Ink): number[][][] {
  const pts = ink.strokes.flatMap((s) => s.points);
  if (!pts.length) return [];
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const h = Math.max(1e-6, Math.max(...pts.map((p) => p.y)) - minY);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return ink.strokes.filter((s) => s.points.length).map((s) => s.points.map((p) => [r((p.x - minX) / h), r((p.y - minY) / h), r(p.p)]));
}

export interface PathResult {
  path: HandwritingPath;
  engine: string;
  /** CER on the held-out set (0.12 = 12%). */
  cer: number;
  lines: number;
  date: string;
}

/** Which paths may be shown to users: only those under their bar, measured on the held-out set with at least 50 lines. */
export function exposed(results: readonly PathResult[]): Record<HandwritingPath, PathResult | null> {
  const best = (path: HandwritingPath) =>
    results
      .filter((r) => r.path === path && r.lines >= 50 && r.cer <= GATES[path])
      .sort((a, b) => a.cer - b.cer)[0] ?? null;
  return { ink: best("ink"), image: best("image") };
}

/** The published line for each result, met or not ("the numbers are published even when they fail"). */
export function publishLine(r: PathResult): string {
  const ok = r.cer <= GATES[r.path] && r.lines >= 50;
  return `${r.date} ${r.path} ${r.engine}: CER ${(r.cer * 100).toFixed(2)}% on ${r.lines} held-out lines — ${ok ? "meets" : "does not meet"} the ${GATES[r.path] * 100}% bar${ok ? "" : " (not shown to users)"}`;
}

/** The prompt for a local vision model reading a handwriting image. */
export function handwritingPrompt(): string {
  return "Transcribe the handwritten line in this image exactly, in the language it is written in (mostly Hebrew, with digits and some English words). Output only the text, one line, no explanation.";
}
