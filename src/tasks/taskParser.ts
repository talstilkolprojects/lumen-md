/**
 * Tasks across the vault (plan 4.13.1): the task line format of the
 * obsidian-tasks plugin, ported.
 *
 * Ported from obsidian-tasks (MIT License, Copyright (c) 2021 Clare Macrae,
 * Ilyas Landikov and Martin Schenck): src/TaskSerializer/DefaultTaskSerializer.ts
 * and src/Task/TaskRegularExpressions.ts. Same symbols, same regular
 * expressions, same right-to-left parsing loop, so a note written for that
 * plugin reads the same here. Differences: dates are plain YYYY-MM-DD
 * strings (no moment.js); recurrence is kept as its text (not expanded);
 * custom statuses map to the plugin's built-in five.
 */

export type TaskStatus = "TODO" | "DONE" | "IN_PROGRESS" | "CANCELLED" | "NON_TASK";
export type Priority = "highest" | "high" | "medium" | "none" | "low" | "lowest";

export interface Task {
  path: string;
  /** 0-based line in the note. */
  line: number;
  status: TaskStatus;
  /** The character between the brackets. */
  symbol: string;
  description: string;
  priority: Priority;
  created: string | null;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  done: string | null;
  cancelled: string | null;
  recurrence: string;
  onCompletion: string;
  id: string;
  dependsOn: string[];
  tags: string[];
  heading: string | null;
  /** `^block-id` at the end of the line, if any. */
  blockLink: string;
  indent: number;
}

/** Upstream DEFAULT_SYMBOLS. */
export const SYMBOLS = {
  priority: { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬" },
  start: "🛫",
  created: "➕",
  scheduled: "⏳",
  due: "📅",
  done: "✅",
  cancelled: "❌",
  recurrence: "🔁",
  onCompletion: "🏁",
  dependsOn: "⛔",
  id: "🆔",
} as const;

const taskId = "[a-zA-Z0-9-_]+";
const taskIdSequence = `${taskId}( *, *${taskId} *)*`;
// ️? allows an optional Variant Selector 16 on the emojis (upstream #3179).
const field = (sym: string, value = "") => new RegExp(`${sym}️?${value ? ` *${value}` : ""}$`);
const dateField = (sym: string) => field(sym, "(\\d{4}-\\d{2}-\\d{2})");

export const RE = {
  priority: field("(🔺|⏫|🔼|🔽|⏬)"),
  start: dateField("🛫"),
  created: dateField("➕"),
  scheduled: dateField("(?:⏳|⌛)"),
  due: dateField("(?:📅|📆|🗓)"),
  done: dateField("✅"),
  cancelled: dateField("❌"),
  recurrence: field("🔁", "([a-zA-Z0-9, !]+)"),
  onCompletion: field("🏁", "([a-zA-Z]+)"),
  dependsOn: field("⛔", `(${taskIdSequence})`),
  id: field("🆔", `(${taskId})`),
  /** Upstream TaskRegularExpressions.taskRegex. */
  task: /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)/u,
  /** A list item whose first child is itself a list item on the same line (`1. 1. [ ] x`), as Obsidian reads it. */
  nestedOnLine: /^([\s\t>]*)(?:[-*+]|[0-9]+[.)]) +((?:[-*+]|[0-9]+[.)]) +\[.\].*)$/u,
  blockLink: / \^[a-zA-Z0-9-]+$/u,
  hashTags: /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g,
  hashTagsFromEnd: /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+$/,
} as const;

const PRIORITY_OF: Record<string, Priority> = { "🔺": "highest", "⏫": "high", "🔼": "medium", "🔽": "low", "⏬": "lowest" };

/** Upstream Status defaults: space, x/X, /, - and everything else as TODO. */
export function statusOf(symbol: string): TaskStatus {
  if (symbol === "x" || symbol === "X") return "DONE";
  if (symbol === "/") return "IN_PROGRESS";
  if (symbol === "-") return "CANCELLED";
  return "TODO";
}

export type TaskDetails = Pick<Task, "description" | "priority" | "created" | "start" | "scheduled" | "due" | "done" | "cancelled" | "recurrence" | "onCompletion" | "id" | "dependsOn" | "tags">;

/** Upstream DefaultTaskSerializer.deserialize: fields are taken off the end, in any order. */
export function parseDetails(text: string): TaskDetails {
  let line = text;
  let matched = false;
  const take = (re: RegExp, set: (m: RegExpMatchArray) => void) => {
    const m = line.match(re);
    if (m) {
      set(m);
      line = line.replace(re, "").trim();
      matched = true;
    }
  };
  const d: TaskDetails = { description: "", priority: "none", created: null, start: null, scheduled: null, due: null, done: null, cancelled: null, recurrence: "", onCompletion: "", id: "", dependsOn: [], tags: [] };
  let trailingTags = "";
  let runs = 0;
  do {
    matched = false;
    take(RE.priority, (m) => (d.priority = PRIORITY_OF[m[1]] ?? "none"));
    take(RE.done, (m) => (d.done = m[1]));
    take(RE.cancelled, (m) => (d.cancelled = m[1]));
    take(RE.due, (m) => (d.due = m[1]));
    take(RE.scheduled, (m) => (d.scheduled = m[1]));
    take(RE.start, (m) => (d.start = m[1]));
    take(RE.created, (m) => (d.created = m[1]));
    take(RE.recurrence, (m) => (d.recurrence = m[1].trim()));
    take(RE.onCompletion, (m) => (d.onCompletion = m[1].toLowerCase()));
    take(RE.hashTagsFromEnd, (m) => {
      const tag = m[0].trim();
      trailingTags = trailingTags ? `${tag} ${trailingTags}` : tag;
    });
    take(RE.id, (m) => (d.id = m[1].trim()));
    take(RE.dependsOn, (m) => (d.dependsOn = m[1].replace(/ /g, "").split(",").filter(Boolean)));
    runs++;
  } while (matched && runs <= 20);
  if (trailingTags) line += (line ? " " : "") + trailingTags;
  d.description = line;
  d.tags = [...line.matchAll(RE.hashTags)].map((m) => m[0].trim());
  return d;
}

/** One line, or null when it isn't a task. */
export function parseTaskLine(text: string, path = "", line = 0, heading: string | null = null): Task | null {
  const nested = RE.nestedOnLine.exec(text);
  if (nested) text = `${nested[1]}${" ".repeat(text.length - nested[1].length - nested[2].length)}${nested[2]}`;
  const m = RE.task.exec(text);
  if (!m) return null;
  const [, indent, , symbol, rest] = m;
  let body = rest;
  let blockLink = "";
  const bl = body.match(RE.blockLink);
  if (bl) {
    blockLink = bl[0].trim();
    body = body.replace(RE.blockLink, "");
  }
  return { path, line, status: statusOf(symbol), symbol, heading, blockLink, indent: indent.replace(/>/g, "").length, ...parseDetails(body.trim()) };
}

/**
 * Every task in a note, with the heading it is under. Lines inside fenced
 * code blocks and the frontmatter are not tasks (as upstream, via the
 * Markdown cache).
 */
export function tasksInNote(path: string, content: string): Task[] {
  const out: Task[] = [];
  const lines = content.split(/\r?\n/);
  let fence: string | null = null;
  // Comment blocks Obsidian's cache skips: `<!-- … -->` and `%% … %%` over several lines.
  let comment: "html" | "md" | null = null;
  let heading: string | null = null;
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1][0].repeat(f[1].length);
      else if (l.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    if (comment) {
      if (comment === "html" ? l.includes("-->") : (l.match(/%%/g)?.length ?? 0) % 2 === 1) comment = null;
      continue;
    }
    if (/^\s*<!--/.test(l) && !l.includes("-->")) {
      comment = "html";
      continue;
    }
    if (/^\s*%%/.test(l) && (l.match(/%%/g)?.length ?? 0) % 2 === 1) {
      comment = "md";
      continue;
    }
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      heading = h[1];
      continue;
    }
    // Cheap pre-check: most lines are not list items with a checkbox.
    if (!l.includes("[")) continue;
    const t = parseTaskLine(l, path, i, heading);
    if (t) out.push(t);
  }
  return out;
}

/** A task back as a line (for toggling done). Upstream field order. */
export function serializeTask(t: Task, marker = "-"): string {
  const parts = [t.description];
  const p = t.priority !== "none" ? SYMBOLS.priority[t.priority] : "";
  if (p) parts.push(p);
  if (t.recurrence) parts.push(`${SYMBOLS.recurrence} ${t.recurrence}`);
  if (t.onCompletion) parts.push(`${SYMBOLS.onCompletion} ${t.onCompletion}`);
  for (const [k, sym] of [["created", SYMBOLS.created], ["start", SYMBOLS.start], ["scheduled", SYMBOLS.scheduled], ["due", SYMBOLS.due], ["cancelled", SYMBOLS.cancelled], ["done", SYMBOLS.done]] as const) {
    if (t[k]) parts.push(`${sym} ${t[k]}`);
  }
  if (t.id) parts.push(`${SYMBOLS.id} ${t.id}`);
  if (t.dependsOn.length) parts.push(`${SYMBOLS.dependsOn} ${t.dependsOn.join(",")}`);
  if (t.blockLink) parts.push(t.blockLink);
  return `${" ".repeat(t.indent)}${marker} [${t.symbol}] ${parts.filter(Boolean).join(" ")}`;
}

/** Toggle done: mark done today (✅ date), or back to todo. */
export function toggleTask(t: Task, today: string): Task {
  if (t.status === "DONE") return { ...t, status: "TODO", symbol: " ", done: null };
  return { ...t, status: "DONE", symbol: "x", done: today };
}
