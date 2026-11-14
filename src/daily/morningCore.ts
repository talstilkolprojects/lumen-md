/**
 * "Your morning" (plan W5.19): a block in today's daily note with what
 * changed in the vault since the last morning, the tasks due today or
 * overdue, the review cards waiting, and the Hebrew date, the week's Torah
 * portion and the day's holidays. All of it from the vault on this device;
 * every row links to its source. The pure part (no app imports): the data
 * and the Markdown; ./morning.ts reads the vault and writes the note.
 */

export interface MorningNote {
  path: string;
  modified: number;
  content: string;
}

export interface MorningTask {
  path: string;
  /** 1-based line of the task in its note. */
  line: number;
  text: string;
  /** ISO date the task is due. */
  due: string;
}

export interface MorningCard {
  front: string;
  link: string;
}

export interface MorningData {
  date: string;
  hebrewDate: string;
  parasha: string;
  holidays: string[];
  changed: Array<{ path: string; modified: number }>;
  changedMore: number;
  tasks: MorningTask[];
  tasksMore: number;
  cardsDue: number;
  cards: MorningCard[];
}

export const START = "<!-- lumen:morning:start -->";
export const END = "<!-- lumen:morning:end -->";
const LIMITS = { changed: 12, tasks: 15, cards: 5 };

/**
 * A task line: `- [ ] text` with a due date — Obsidian Tasks' `📅 2026-11-12`,
 * Dataview's `[due:: 2026-11-12]` / `due:: …`, or `@due(2026-11-12)`.
 */
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+)$/;
const DUE = /(?:📅\s*|\[?due::\s*|@due\()(\d{4}-\d{2}-\d{2})\)?\]?/u;

export function tasksDue(notes: readonly MorningNote[], today: string): MorningTask[] {
  const out: MorningTask[] = [];
  for (const n of notes) {
    if (!n.content.includes("[ ]")) continue; // fast skip: most notes have no open task
    const lines = n.content.split("\n");
    let fence = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (fence) continue;
      const m = TASK.exec(l);
      if (!m) continue;
      const d = DUE.exec(m[1]);
      if (!d || d[1] > today) continue;
      out.push({ path: n.path, line: i + 1, text: m[1].replace(DUE, "").replace(/\s+/g, " ").trim(), due: d[1] });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.path.localeCompare(b.path) || a.line - b.line);
}

export interface MorningInput {
  date: string;
  hebrewDate: string;
  parasha: string;
  holidays: string[];
  notes: readonly MorningNote[];
  /** Changes after this time (ms) count; the last morning, or a day ago. */
  since: number;
  /** Paths left out of "changed" (today's note itself, daily notes, .lumen/). */
  skip: (path: string) => boolean;
  cardsDue: number;
  cards: MorningCard[];
}

export function morningData(i: MorningInput): MorningData {
  const changedAll = i.notes.filter((n) => n.modified > i.since && !i.skip(n.path)).sort((a, b) => b.modified - a.modified);
  const tasks = tasksDue(i.notes, i.date);
  return {
    date: i.date,
    hebrewDate: i.hebrewDate,
    parasha: i.parasha,
    holidays: i.holidays,
    changed: changedAll.slice(0, LIMITS.changed).map((n) => ({ path: n.path, modified: n.modified })),
    changedMore: Math.max(0, changedAll.length - LIMITS.changed),
    tasks: tasks.slice(0, LIMITS.tasks),
    tasksMore: Math.max(0, tasks.length - LIMITS.tasks),
    cardsDue: i.cardsDue,
    cards: i.cards.slice(0, LIMITS.cards),
  };
}

export interface MorningWords {
  title: string;
  changed: string;
  noChanges: string;
  tasks: string;
  noTasks: string;
  overdue: (due: string) => string;
  review: (n: number) => string;
  noReview: string;
  openReview: string;
  more: (n: number) => string;
  holidays: string;
}

const link = (path: string, label?: string) => `[[${path.replace(/\.md$/i, "")}${label ? `|${label}` : ""}]]`;
const nameOf = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");
/** Wiki-link text must not close the link or start a new one. */
const safe = (s: string) => s.replace(/\[\[|\]\]|\|/g, " ").slice(0, 140);

export function renderMorning(d: MorningData, w: MorningWords): string {
  const lines = [START, `## ${w.title}`, "", `**${d.hebrewDate}** · ${d.parasha}${d.holidays.length ? ` · ${w.holidays}: ${d.holidays.join(" · ")}` : ""}`, ""];
  lines.push(`### ${w.changed}`);
  if (!d.changed.length) lines.push(`- ${w.noChanges}`);
  for (const c of d.changed) lines.push(`- ${link(c.path, nameOf(c.path))}`);
  if (d.changedMore) lines.push(`- ${w.more(d.changedMore)}`);
  lines.push("", `### ${w.tasks}`);
  if (!d.tasks.length) lines.push(`- ${w.noTasks}`);
  for (const t of d.tasks) lines.push(`- ${safe(t.text)} — ${link(t.path, nameOf(t.path))}${t.due < d.date ? ` (${w.overdue(t.due)})` : ""}`);
  if (d.tasksMore) lines.push(`- ${w.more(d.tasksMore)}`);
  lines.push("", `### ${w.review(d.cardsDue)}`);
  if (!d.cardsDue) lines.push(`- ${w.noReview}`);
  for (const c of d.cards) lines.push(`- ${safe(c.front)} — [[${c.link.replace(/^\[\[|\]\]$/g, "")}]]`);
  if (d.cardsDue) lines.push(`- ${w.openReview}`);
  lines.push(END);
  return lines.join("\n");
}

/** Put the block into the note: replace the previous one, or add it after the first heading block. */
export function upsertMorning(note: string, block: string): string {
  const a = note.indexOf(START);
  const b = note.indexOf(END);
  if (a >= 0 && b > a) return note.slice(0, a) + block + note.slice(b + END.length);
  const firstBlank = note.search(/\n\s*\n/);
  if (firstBlank < 0) return `${note.replace(/\s*$/, "")}\n\n${block}\n`;
  return `${note.slice(0, firstBlank)}\n\n${block}\n${note.slice(firstBlank)}`;
}
