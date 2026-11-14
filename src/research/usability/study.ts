/**
 * The study's content (plan W1.29): the ten tasks and the questionnaires,
 * in Hebrew (the participants' language) and English (for the team). The
 * protocol, research/usability/protocol.he.md, reads them to the
 * participant word for word; src/__tests__/usabilityKit.test.ts keeps the
 * two in step.
 */

export interface StudyTask {
  id: number;
  he: string;
  en: string;
  /** Minutes before the moderator stops the task (outcome: gave-up). */
  limitMin: number;
}

export const TASKS: readonly StudyTask[] = [
  { id: 1, he: "פתק חדש", en: "A new note", limitMin: 3 },
  { id: 2, he: "רשימת משימות", en: "A checklist", limitMin: 3 },
  { id: 3, he: "קישור בין פתקים", en: "Linking notes", limitMin: 4 },
  { id: 4, he: "חיפוש", en: "Search", limitMin: 3 },
  { id: 5, he: "תגיות", en: "Tags", limitMin: 4 },
  { id: 6, he: "עברית ואנגלית באותה שורה", en: "Hebrew and English on one line", limitMin: 4 },
  { id: 7, he: "טבלה", en: "A table", limitMin: 4 },
  { id: 8, he: "ייצוא", en: "Export", limitMin: 3 },
  { id: 9, he: "שחזור מהאשפה", en: "Restoring from the trash", limitMin: 4 },
  { id: 10, he: "הפתק היומי", en: "The daily note", limitMin: 3 },
];

/**
 * The System Usability Scale (Brooke, 1996), "the system" replaced by
 * "Lumen" as is usual. The Hebrew is this study's translation, not a
 * validated one: compare scores across our own rounds, and treat
 * comparisons with published SUS norms as approximate.
 */
export const SUS_ITEMS: readonly { he: string; en: string }[] = [
  { he: "אני חושב/ת שארצה להשתמש ב-Lumen לעיתים קרובות.", en: "I think that I would like to use Lumen frequently." },
  { he: "מצאתי ש-Lumen מסובך שלא לצורך.", en: "I found Lumen unnecessarily complex." },
  { he: "חשבתי ש-Lumen קל לשימוש.", en: "I thought Lumen was easy to use." },
  { he: "אני חושב/ת שאצטרך עזרה של איש/אשת טכנולוגיה כדי להשתמש ב-Lumen.", en: "I think that I would need the support of a technical person to be able to use Lumen." },
  { he: "מצאתי שהיכולות השונות ב-Lumen משתלבות היטב זו בזו.", en: "I found the various functions in Lumen were well integrated." },
  { he: "חשבתי שיש ב-Lumen יותר מדי חוסר עקביות.", en: "I thought there was too much inconsistency in Lumen." },
  { he: "אני מניח/ה שרוב האנשים ילמדו להשתמש ב-Lumen מהר מאוד.", en: "I would imagine that most people would learn to use Lumen very quickly." },
  { he: "מצאתי שהשימוש ב-Lumen מסורבל מאוד.", en: "I found Lumen very cumbersome to use." },
  { he: "הרגשתי בטוח/ה מאוד בשימוש ב-Lumen.", en: "I felt very confident using Lumen." },
  { he: "הייתי צריך/ה ללמוד הרבה דברים לפני שיכולתי להתחיל לעבוד עם Lumen.", en: "I needed to learn a lot of things before I could get going with Lumen." },
];

export const SUS_SCALE = {
  he: ["מאוד לא מסכים/ה", "לא מסכים/ה", "ניטרלי", "מסכים/ה", "מסכים/ה מאוד"],
  en: ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"],
} as const;

/** The Single Ease Question, after each task (Sauro & Dumas, 2009). */
export const SEQ_QUESTION = {
  he: "באופן כללי, עד כמה המשימה הייתה קשה או קלה?",
  en: "Overall, how difficult or easy was the task to complete?",
  low: { he: "קשה מאוד", en: "Very difficult" },
  high: { he: "קלה מאוד", en: "Very easy" },
} as const;

/** SUS score, 0–100: odd items score − 1, even items 5 − score, sum × 2.5. */
export function susScore(answers: readonly number[]): number {
  if (answers.length !== 10 || answers.some((a) => !Number.isInteger(a) || a < 1 || a > 5)) throw new Error("SUS needs 10 answers, 1…5");
  let sum = 0;
  answers.forEach((a, i) => (sum += i % 2 === 0 ? a - 1 : 5 - a));
  return sum * 2.5;
}
