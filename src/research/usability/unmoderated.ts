/**
 * The self-guided (unmoderated) usability session (plan W4.25): the same
 * ten tasks as the moderated kit (study.ts), done by the participant alone,
 * with the instructions on screen instead of read aloud.
 *
 * Without a moderator, three things the moderator did move into the app:
 *  - **Setup.** `seedPracticeNotes` writes the practice notes into their own
 *    folder and puts "טיוטה ישנה" in the trash for task 9 (protocol §3).
 *  - **Judging the outcome.** Where the result is in the notes, `verifyTask`
 *    checks it (true / false), and only that boolean is recorded — never
 *    the note text. Tasks whose result is a view or a file (search, export)
 *    return null: the participant's own "done" counts, marked unverified.
 *  - **The time limit.** Finishing after the task's limit counts as partial.
 *
 * Pure apart from the `VaultAccess` the caller passes in.
 */
import { TASKS } from "./study";
import type { Outcome, Session } from "./sessionRecorder";

/** Where the practice notes go: a folder of their own, so the participant's other notes stay apart. */
export const SEED_FOLDER = "בדיקת שימושיות";
/** The note task 2 starts from (protocol: "the moderator types beforehand"). */
export const TODO_NOTE = "משימות";
export const TODO_LINES = ["לקנות מחברת", "להירשם לסמינר", "לשלוח מייל למרצה"];
/** The note that waits in the trash for task 9. */
export const TRASHED_NOTE = "טיוטה ישנה";
export const SENTENCE_6 = "בשנת 2026 אלמד Machine Learning בקורס המתקדם.";

/** What the participant reads for each task: the moderated scenario, rewritten to stand alone. */
export const SCRIPTS: Record<number, { he: string; en: string }> = {
  1: { he: "את/ה מתחיל/ה קורס חדש. צור/צרי פתק בשם „רשימת קריאה”, עם הכותרת „ספרים לסמסטר” ושתי שורות של ספרים מתחתיה.", en: "You are starting a new course. Create a note named “רשימת קריאה” with the heading “ספרים לסמסטר” and two lines of books under it." },
  2: { he: `בתיקייה „${SEED_FOLDER}” יש פתק בשם „${TODO_NOTE}” עם שלוש שורות. הפוך/הפכי אותן לרשימת משימות, וסמן/י את הראשונה כבוצעה.`, en: `The folder “${SEED_FOLDER}” has a note “${TODO_NOTE}” with three lines. Turn them into a checklist and tick the first one.` },
  3: { he: "בפתק „רשימת קריאה”, הוסף/הוסיפי קישור לפתק „סמינר מחקר”, ואז עבור/עברי אליו דרך הקישור.", en: "In the note “רשימת קריאה”, add a link to the note “סמינר מחקר”, then open it through the link." },
  4: { he: "מצא/י את כל הפתקים שמוזכרת בהם המילה „ראיון”. כשהם מוצגים לפניך, לחץ/י „סיימתי”.", en: "Find every note that mentions the word “ראיון”. When they are on screen, press “Done”." },
  5: { he: "סמן/י את הפתק „רשימת קריאה” בתגית „קורס”, ואז הצג/הציגי את כל הפתקים עם התגית הזו.", en: "Tag the note “רשימת קריאה” with “קורס”, then show every note with that tag." },
  6: { he: `כתוב/כתבי בפתק כלשהו את המשפט: „${SENTENCE_6}” ובדוק/בדקי שהוא נקרא נכון, גם בעריכה וגם בתצוגה.`, en: `Write this sentence in any note: “${SENTENCE_6}” and check that it reads correctly, both while editing and in the preview.` },
  7: { he: "הוסף/הוסיפי לפתק „רשימת קריאה” טבלה עם שתי עמודות, „ספר” ו„מחבר/ת”, ושתי שורות של ספרים.", en: "Add a table to “רשימת קריאה” with two columns, “ספר” and “מחבר/ת”, and two rows of books." },
  8: { he: "את/ה רוצה לשלוח את „רשימת קריאה” למרצה כקובץ PDF. שמור/שמרי אותו כ-PDF.", en: "You want to send “רשימת קריאה” to your lecturer as a PDF. Save it as a PDF." },
  9: { he: `אתמול נמחק בטעות הפתק „${TRASHED_NOTE}”. החזר/החזירי אותו.`, en: `Yesterday the note “${TRASHED_NOTE}” was deleted by mistake. Bring it back.` },
  10: { he: "פתח/פתחי את הפתק היומי של היום והוסף/הוסיפי לו את השורה: „לקרוא פרק 3”.", en: "Open today’s daily note and add the line “לקרוא פרק 3”." },
};

export interface VaultAccess {
  /** Every note path in the vault (trash excluded). */
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
}

export interface SeedAccess {
  exists(path: string): Promise<boolean>;
  write(path: string, text: string): Promise<void>;
  /** Move to the app's trash (restorable). */
  trash(path: string): Promise<void>;
}

/** Write the practice notes (`notes`: file name → text, the seed vault) that are not there yet, and trash the one for task 9. */
export async function seedPracticeNotes(fs: SeedAccess, notes: Record<string, string>): Promise<{ written: string[] }> {
  const written: string[] = [];
  const all = { ...notes, [`${TODO_NOTE}.md`]: `# ${TODO_NOTE}\n\n${TODO_LINES.join("\n")}\n` };
  for (const [name, text] of Object.entries(all)) {
    const path = `${SEED_FOLDER}/${name}`;
    if (await fs.exists(path)) continue;
    await fs.write(path, text);
    written.push(path);
  }
  const draft = `${SEED_FOLDER}/${TRASHED_NOTE}.md`;
  if (written.includes(draft)) await fs.trash(draft);
  return { written };
}

const base = (p: string) => p.replace(/^.*\//, "").replace(/\.md$/i, "");
const lines = (t: string) => t.split("\n").map((l) => l.trim());

async function noteNamed(v: VaultAccess, name: string): Promise<string | null> {
  const path = (await v.list()).find((p) => base(p) === name);
  return path ? v.read(path) : null;
}

async function anyNote(v: VaultAccess, test: (text: string, path: string) => boolean): Promise<boolean> {
  for (const p of await v.list()) if (test(await v.read(p), p)) return true;
  return false;
}

/** Does `text` hold a Markdown table whose header has every word of `cols`, with at least `rows` body rows? */
export function hasTable(text: string, cols: string[], rows: number): boolean {
  const ls = text.split("\n");
  for (let i = 0; i + 1 < ls.length; i++) {
    if (!ls[i].includes("|") || !/^\s*\|?\s*:?-{3,}/.test(ls[i + 1])) continue;
    const header = ls[i];
    if (!cols.every((c) => header.includes(c))) continue;
    let n = 0;
    for (let j = i + 2; j < ls.length && ls[j].includes("|") && ls[j].trim(); j++) if (ls[j].replace(/[|\s-]/g, "")) n++;
    if (n >= rows) return true;
  }
  return false;
}

/** Is `tag` on the note: inline `#tag`, or in front matter `tags:`. */
export function hasTag(text: string, tag: string): boolean {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const fmTags = /^tags:\s*(.*)$/m.exec(fm);
  if (fmTags && (fmTags[1].split(/[[\],\s]+/).map((x) => x.replace(/^["'#]|["']$/g, "")).includes(tag) || new RegExp(`^\\s+-\\s+["']?#?${tag}["']?\\s*$`, "m").test(fm))) return true;
  return new RegExp(`(^|\\s)#${tag}(?=$|[\\s.,;:!?)])`, "mu").test(text);
}

/**
 * Was task `id` done, judged from the notes? true / false, or null when the
 * result is not in the notes (a search view, an exported file) — then the
 * participant's own report stands. `today` is the local date, YYYY-MM-DD.
 */
export async function verifyTask(id: number, v: VaultAccess, today: string): Promise<boolean | null> {
  switch (id) {
    case 1: {
      const t = await noteNamed(v, "רשימת קריאה");
      if (t === null) return false;
      const ls = lines(t);
      const h = ls.findIndex((l) => /^#{1,6}\s+.*ספרים לסמסטר/.test(l));
      return h >= 0 && ls.slice(h + 1).filter((l) => l && !l.startsWith("#")).length >= 2;
    }
    case 2: {
      const t = await noteNamed(v, TODO_NOTE);
      if (t === null) return false;
      const items = TODO_LINES.map((x) => lines(t).find((l) => l.includes(x)) ?? "");
      return /^[-*+]\s+\[[xX]\]/.test(items[0]) && items.slice(1).every((l) => /^[-*+]\s+\[ \]/.test(l));
    }
    case 3: {
      const t = await noteNamed(v, "רשימת קריאה");
      return t !== null && /\[\[\s*סמינר מחקר\s*(?:[|#][^\]]*)?\]\]|\]\(<?[^)]*סמינר(?:%20| )מחקר(?:\.md)?>?\)/.test(t);
    }
    case 5: {
      const t = await noteNamed(v, "רשימת קריאה");
      return t !== null && hasTag(t, "קורס");
    }
    case 6:
      return anyNote(v, (t) => t.includes(SENTENCE_6.replace(/\.$/, "")));
    case 7: {
      const t = await noteNamed(v, "רשימת קריאה");
      return t !== null && hasTable(t, ["ספר", "מחבר"], 2);
    }
    case 9:
      return (await v.list()).some((p) => base(p) === TRASHED_NOTE);
    case 10:
      return anyNote(v, (t, p) => base(p).includes(today) && t.includes("לקרוא פרק 3"));
    default:
      return null;
  }
}

/**
 * The outcome of a self-reported attempt. "done" + verified → success
 * (partial past the time limit); "done" but the notes say otherwise →
 * fail (protocol: thinks they finished, the result is wrong); "done" with
 * nothing to check → success, unverified; "gave up" → gave-up.
 */
export function outcomeOf(report: "done" | "gave-up", verified: boolean | null, seconds: number, task: number): Outcome {
  if (report === "gave-up") return "gave-up";
  if (verified === false) return "fail";
  const limit = (TASKS.find((t) => t.id === task)?.limitMin ?? 5) * 60;
  return seconds > limit ? "partial" : "success";
}

/** A participant code for a self-guided session: U- and four letters or digits, random, never a name. */
export function newSelfCode(rand: () => number = Math.random): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(rand() * abc.length)];
  return `U-${s}`;
}

/** The next thing the participant does in a self-guided session. */
export type Step =
  | { kind: "intro" }
  | { kind: "task"; task: number }
  | { kind: "running"; task: number; since: number }
  | { kind: "seq"; task: number }
  | { kind: "sus" }
  | { kind: "done" };

/** Where a self-guided session is, from its events (so a reload continues where it was). */
export function stepOf(s: Session | null): Step {
  if (!s) return { kind: "intro" };
  if (s.endedAt) return { kind: "done" };
  const ended = new Set<number>();
  let open: { task: number; t: number } | null = null;
  for (const e of s.events) {
    if (e.type === "task-start") open = { task: e.task, t: e.t };
    else if (e.type === "task-end") {
      ended.add(e.task);
      if (open?.task === e.task) open = null;
    }
  }
  if (open) return { kind: "running", task: open.task, since: open.t };
  const lastEnd = [...s.events].reverse().find((e) => e.type === "task-end");
  if (lastEnd?.type === "task-end" && s.seq[lastEnd.task] === undefined) return { kind: "seq", task: lastEnd.task };
  const next = TASKS.find((x) => !ended.has(x.id));
  return next ? { kind: "task", task: next.id } : { kind: "sus" };
}

