/**
 * Book-writing mode (plan W5.8): a book is an index note whose frontmatter
 * lists its chapters in order — the format of Obsidian's Longform plugin, so
 * a book written in Lumen opens in Obsidian + Longform and the other way:
 *
 *   ---
 *   longform:
 *     format: scenes
 *     title: הספר שלי
 *     sceneFolder: /          # chapters, relative to the index note's folder
 *     scenes:
 *       - פתיחה
 *       - - סצנה בתוך פתיחה    # a nested list: parts inside a chapter
 *       - הפרק השני
 *   word-goal: 80000           # Lumen: the book's goal
 *   daily-goal: 500            # Lumen: words a day, for the streak
 *   author: נועה
 *   lang: he
 *   ---
 *
 * A chapter's own goal is `word-goal:` in its frontmatter. Lumen's keys sit
 * outside `longform:`, which Longform rewrites.
 *
 * Pure: reading and writing the vault is the caller's (src/book/app.ts).
 */
import YAML, { isMap, isSeq, parseDocument, type Document } from "yaml";
import { countWords } from "./wordCount";

export interface BookChapterRef {
  /** The scene name as written (a note name, without `.md`). */
  name: string;
  /** Vault path of the chapter note. */
  path: string;
  /** 0 for a chapter, 1+ for a part nested inside the one before. */
  depth: number;
}

export interface BookIndex {
  path: string;
  title: string;
  author?: string;
  lang?: string;
  chapters: BookChapterRef[];
  wordGoal?: number;
  dailyGoal?: number;
}

const FM = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const stemOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** Frontmatter as data (null when there is none or it does not parse). */
export function frontmatterOf(text: string): Record<string, unknown> | null {
  const m = FM.exec(text);
  if (!m) return null;
  try {
    const v: unknown = YAML.parse(m[1]);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function joinPath(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function flatten(scenes: unknown, depth: number, folder: string, out: BookChapterRef[]): void {
  if (!Array.isArray(scenes)) return;
  for (const s of scenes) {
    if (Array.isArray(s)) flatten(s, depth + 1, folder, out);
    else if (typeof s === "string" || typeof s === "number") {
      const name = String(s).trim();
      if (name) out.push({ name, path: joinPath(folder, `${name}.md`), depth });
    }
  }
}

/** The book an index note describes, or null when the note is not a book index. */
export function parseBookIndex(path: string, text: string): BookIndex | null {
  const fm = frontmatterOf(text);
  const lf = fm?.longform;
  if (!fm || !isRecord(lf) || (lf.format !== undefined && lf.format !== "scenes")) return null;
  const sceneFolder = typeof lf.sceneFolder === "string" ? lf.sceneFolder : "/";
  const folder = sceneFolder.startsWith("/") ? joinPath(dirOf(path), sceneFolder) : joinPath(dirOf(path), sceneFolder);
  const chapters: BookChapterRef[] = [];
  flatten(lf.scenes, 0, folder, chapters);
  return {
    path,
    title: typeof lf.title === "string" && lf.title.trim() ? lf.title.trim() : stemOf(path),
    author: typeof fm.author === "string" ? fm.author : undefined,
    lang: typeof fm.lang === "string" ? fm.lang : undefined,
    chapters,
    wordGoal: posInt(fm["word-goal"]),
    dailyGoal: posInt(fm["daily-goal"]),
  };
}

/** The text of a new book index for `chapters` (note names, in order). */
export function newBookIndex(opts: { title: string; chapters: string[]; lang?: string; wordGoal?: number; dailyGoal?: number }): string {
  const doc = new YAML.Document({
    longform: { format: "scenes", title: opts.title, workflow: "Default Workflow", sceneFolder: "/", scenes: opts.chapters, ignoredFiles: [] },
    ...(opts.wordGoal ? { "word-goal": opts.wordGoal } : {}),
    ...(opts.dailyGoal ? { "daily-goal": opts.dailyGoal } : {}),
    ...(opts.lang ? { lang: opts.lang } : {}),
  });
  return `---\n${doc.toString({ lineWidth: 0 })}---\n\n# ${opts.title}\n`;
}

/** Edit the index's YAML in place: only what `edit` touches changes (comments and order stay). */
function editIndex(text: string, edit: (doc: Document) => void): string {
  const m = FM.exec(text);
  if (!m) throw new Error("not a book index: no frontmatter");
  const eol = m[0].includes("\r\n") ? "\r\n" : "\n";
  const doc = parseDocument(m[1].replace(/\r\n/g, "\n"));
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  edit(doc);
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n$/, "").replace(/\n/g, eol);
  const start = m.index + m[0].indexOf(m[1]);
  return text.slice(0, start) + yaml + text.slice(start + m[1].length);
}

/**
 * Move the top-level chapter at `from` to `to` (a nested part moves with its
 * chapter). Returns the index text with only `scenes:` changed.
 */
export function moveChapter(text: string, from: number, to: number): string {
  return editIndex(text, (doc) => {
    const scenes = doc.getIn(["longform", "scenes"], true);
    if (!isSeq(scenes)) throw new Error("the book has no scenes: list");
    // Units: a chapter and the nested list right after it.
    const units: unknown[][] = [];
    for (const item of scenes.items) {
      if (isSeq(item) && units.length) units[units.length - 1].push(item);
      else units.push([item]);
    }
    if (from < 0 || from >= units.length || to < 0 || to >= units.length) throw new Error("no such chapter");
    const [unit] = units.splice(from, 1);
    units.splice(to, 0, unit);
    scenes.items = units.flat() as typeof scenes.items;
  });
}

/** Add a chapter (note name) at the end of the book. */
export function addChapter(text: string, name: string): string {
  return editIndex(text, (doc) => {
    const lf = doc.get("longform", true);
    if (!isMap(lf)) throw new Error("not a book index");
    const scenes = lf.get("scenes", true);
    if (isSeq(scenes)) scenes.add(doc.createNode(name));
    else lf.set("scenes", doc.createNode([name]));
  });
}

/* ─── Progress ───────────────────────────────────────────────────────── */

export interface ChapterProgress {
  ref: BookChapterRef;
  /** null: the note is missing. */
  words: number | null;
  goal?: number;
  title: string;
}

export interface BookProgress {
  chapters: ChapterProgress[];
  words: number;
  goal?: number;
  /** 0–1 of the book goal (or of the chapter goals added up). */
  share: number | null;
  missing: string[];
}

/** The first `# heading` of a chapter, else its note name. */
export function chapterTitle(name: string, text: string): string {
  const fm = frontmatterOf(text);
  if (fm && typeof fm.title === "string" && fm.title.trim()) return fm.title.trim();
  const body = text.replace(FM, "");
  return /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? name;
}

/**
 * What a chapter prints: its text without the frontmatter and without the
 * first `# heading` when that heading is the chapter's title (the book
 * prints the title itself, once).
 */
export function chapterBody(text: string): string {
  const body = text.replace(/^\uFEFF/, "").replace(FM, "");
  return body.replace(/^\s*#[ \t]+[^\n]*\n?/, "");
}

/** Words per chapter and for the book; `read` gives a chapter's text (null: missing). */
export function bookProgress(book: BookIndex, read: (path: string) => string | null): BookProgress {
  const chapters = book.chapters.map((ref): ChapterProgress => {
    const text = read(ref.path);
    if (text === null) return { ref, words: null, title: ref.name };
    return { ref, words: countWords(text), goal: posInt(frontmatterOf(text)?.["word-goal"]), title: chapterTitle(ref.name, text) };
  });
  const words = chapters.reduce((n, c) => n + (c.words ?? 0), 0);
  const chapterGoals = chapters.reduce((n, c) => n + (c.goal ?? 0), 0);
  const goal = book.wordGoal ?? (chapterGoals || undefined);
  return { chapters, words, goal, share: goal ? Math.min(1, words / goal) : null, missing: chapters.filter((c) => c.words === null).map((c) => c.ref.path) };
}

/* ─── Daily goal and streak ──────────────────────────────────────────── */

/** The book's total at the end of each day (`YYYY-MM-DD` → words), kept next to the index. */
export type WordLog = Record<string, number>;

export const logPathFor = (indexPath: string) => joinPath(dirOf(indexPath), `.${stemOf(indexPath)}.lumen-book.json`);

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const prevDay = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d - 1));
};

/** The log with today's total recorded (days are the writer's local days). */
export function recordWords(log: WordLog, total: number, now: Date): WordLog {
  return { ...log, [dayKey(now)]: total };
}

/** Words written on `day`: its total minus the last earlier day's (deletions count against it). */
export function wordsOn(log: WordLog, day: string): number {
  if (!(day in log)) return 0;
  const before = Object.keys(log)
    .filter((k) => k < day)
    .sort()
    .pop();
  return log[day] - (before ? log[before] : log[day]);
}

export interface DailyProgress {
  today: number;
  goal?: number;
  /** Days in a row, up to today, on which the daily goal was met (today counts once met). */
  streak: number;
}

export function dailyProgress(log: WordLog, now: Date, dailyGoal?: number): DailyProgress {
  const today = dayKey(now);
  const todayWords = wordsOn(log, today);
  let streak = 0;
  if (dailyGoal) {
    let day = todayWords >= dailyGoal ? today : prevDay(today);
    while (wordsOn(log, day) >= dailyGoal && day in log) {
      streak++;
      day = prevDay(day);
    }
  }
  return { today: todayWords, goal: dailyGoal, streak };
}
