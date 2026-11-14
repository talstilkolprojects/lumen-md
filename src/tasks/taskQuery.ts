/**
 * The ```tasks``` query language (plan 4.13.2), ported from obsidian-tasks
 * (MIT License, Copyright (c) 2021 Clare Macrae, Ilyas Landikov and Martin
 * Schenck; src/Query/). One instruction per line; every filter must match
 * (lines AND together); `(a) OR (b)`, `(a) AND (b)`, `NOT (a)` combine
 * filters on one line.
 *
 * Supported (upstream spelling):
 *   done | not done
 *   due|scheduled|starts|done|created|cancelled|happens (on|before|after|on or before|on or after) <date>
 *   due|… in YYYY-MM-DD YYYY-MM-DD
 *   has|no due|scheduled|start|done|created|cancelled|happens date
 *   priority is (above|below|not)? <level>
 *   description|path|folder|filename|heading|tag (includes|does not include) <text>
 *   description|path|heading|tag (regex matches|regex does not match) /re/flags
 *   tags (include|do not include) <tag>, has tags, no tags
 *   status.type is (TODO|DONE|IN_PROGRESS|CANCELLED)
 *   is recurring | is not recurring, has id | no id, is blocked | is not blocked
 *   sort by <field> [reverse], group by <field>, limit [to] N [tasks], hide <x>, short mode
 * Dates: YYYY-MM-DD, today, tomorrow, yesterday, "in N days", "N days ago",
 * next/last week/month. Unknown lines are reported, not ignored.
 */
import type { Priority, Task } from "./taskParser";

export interface TaskQuery {
  filters: Array<(t: Task, all: Task[]) => boolean>;
  sorts: Array<{ key: SortKey; reverse: boolean }>;
  group: GroupKey | null;
  limit: number | null;
  hide: Set<string>;
  errors: QueryError[];
}

/** What a query line got wrong; the block shows it in the user's language. */
export interface QueryError {
  code: "date" | "regex" | "query";
  /** The part of the line that wasn't understood. */
  text: string;
}

type SortKey = "due" | "scheduled" | "start" | "done" | "created" | "priority" | "description" | "path" | "status" | "urgency" | "filename" | "heading";
type GroupKey = "due" | "scheduled" | "priority" | "path" | "folder" | "filename" | "heading" | "status" | "tags";

const DATE_FIELDS = { due: "due", scheduled: "scheduled", starts: "start", start: "start", done: "done", created: "created", cancelled: "cancelled" } as const;
const PRIORITY_RANK: Record<Priority, number> = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** A date phrase → YYYY-MM-DD, relative to `today`. */
export function parseDate(text: string, today: Date): string | null {
  const s = text.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === "today") return iso(today);
  if (s === "tomorrow") return iso(addDays(today, 1));
  if (s === "yesterday") return iso(addDays(today, -1));
  let m = /^in (\d+) (day|week)s?$/.exec(s);
  if (m) return iso(addDays(today, Number(m[1]) * (m[2] === "week" ? 7 : 1)));
  m = /^(\d+) (day|week)s? ago$/.exec(s);
  if (m) return iso(addDays(today, -Number(m[1]) * (m[2] === "week" ? 7 : 1)));
  if (s === "next week") return iso(addDays(today, 7));
  if (s === "last week") return iso(addDays(today, -7));
  if (s === "next month") return iso(new Date(today.getFullYear(), today.getMonth() + 1, today.getDate()));
  if (s === "last month") return iso(new Date(today.getFullYear(), today.getMonth() - 1, today.getDate()));
  return null;
}

const happens = (t: Task) => [t.start, t.scheduled, t.due].filter((d): d is string => !!d);
const dates = (t: Task, f: string): string[] => (f === "happens" ? happens(t) : [t[DATE_FIELDS[f as keyof typeof DATE_FIELDS]]].filter((d): d is string => !!d));
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "/");
const fileOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function regexOf(s: string): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/.exec(s.trim());
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2].replace(/[gy]/g, ""));
  } catch {
    return null;
  }
}

function textOf(t: Task, f: string): string[] {
  switch (f) {
    case "description":
      return [t.description];
    case "path":
      return [t.path];
    case "folder":
      return [folderOf(t.path)];
    case "filename":
      return [fileOf(t.path)];
    case "heading":
      return [t.heading ?? ""];
    case "tag":
    case "tags":
      return t.tags;
    default:
      return [];
  }
}

type Filter = (t: Task, all: Task[]) => boolean;

const isError = (f: Filter | QueryError): f is QueryError => typeof f !== "function";

/** One filter instruction, or what is wrong with it. */
export function parseFilter(raw: string, today: Date): Filter | QueryError {
  const line = raw.trim();
  const lower = line.toLowerCase();
  // Boolean combinations: (a) OR (b), (a) AND (b), NOT (a).
  const not = /^not\s*\((.*)\)$/i.exec(line);
  if (not) {
    const f = parseFilter(not[1], today);
    return isError(f) ? f : (t, all) => !f(t, all);
  }
  const bool = /^\((.*)\)\s+(AND|OR|XOR)\s+\((.*)\)$/i.exec(line);
  if (bool) {
    const a = parseFilter(bool[1], today);
    const b = parseFilter(bool[3], today);
    if (isError(a)) return a;
    if (isError(b)) return b;
    const op = bool[2].toUpperCase();
    return op === "AND" ? (t, all) => a(t, all) && b(t, all) : op === "OR" ? (t, all) => a(t, all) || b(t, all) : (t, all) => a(t, all) !== b(t, all);
  }
  if (lower === "done") return (t) => t.status === "DONE" || t.status === "CANCELLED";
  if (lower === "not done") return (t) => t.status === "TODO" || t.status === "IN_PROGRESS";
  if (lower === "is recurring") return (t) => !!t.recurrence;
  if (lower === "is not recurring") return (t) => !t.recurrence;
  if (lower === "has id") return (t) => !!t.id;
  if (lower === "no id") return (t) => !t.id;
  if (lower === "has tags") return (t) => t.tags.length > 0;
  if (lower === "no tags") return (t) => t.tags.length === 0;
  if (lower === "has depends on") return (t) => t.dependsOn.length > 0;
  if (lower === "no depends on") return (t) => t.dependsOn.length === 0;
  if (lower === "is blocked" || lower === "is not blocked") {
    const want = lower === "is blocked";
    return (t, all) => {
      const blocked = t.dependsOn.some((id) => all.some((o) => o.id === id && (o.status === "TODO" || o.status === "IN_PROGRESS")));
      return blocked === want && (t.status === "TODO" || t.status === "IN_PROGRESS");
    };
  }
  let m = /^(has|no) (due|scheduled|start|done|created|cancelled|happens) date$/.exec(lower);
  if (m) {
    const [, hasNo, f] = m;
    return (t) => (dates(t, f === "start" ? "starts" : f).length > 0) === (hasNo === "has");
  }
  m = /^(due|scheduled|starts|done|created|cancelled|happens) in (\d{4}-\d{2}-\d{2}) (\d{4}-\d{2}-\d{2})$/.exec(lower);
  if (m) {
    const [, f, a, b] = m;
    return (t) => dates(t, f).some((d) => d >= a && d <= b);
  }
  m = /^(due|scheduled|starts|done|created|cancelled|happens)(?: (on or before|on or after|on|before|after))? (.+)$/.exec(lower);
  if (m && !/^(includes|does not include|regex)/.test(m[3])) {
    const [, f, op = "on", phrase] = m;
    const d = parseDate(phrase, today);
    if (!d) return { code: "date", text: phrase };
    const cmp: Record<string, (x: string) => boolean> = { on: (x) => x === d, before: (x) => x < d, after: (x) => x > d, "on or before": (x) => x <= d, "on or after": (x) => x >= d };
    return (t) => dates(t, f).some(cmp[op]);
  }
  m = /^priority is (?:(above|below|not) )?(highest|high|medium|none|low|lowest)$/.exec(lower);
  if (m) {
    const [, op, level] = m;
    const r = PRIORITY_RANK[level as Priority];
    return (t) => {
      const x = PRIORITY_RANK[t.priority];
      return op === "above" ? x < r : op === "below" ? x > r : op === "not" ? x !== r : x === r;
    };
  }
  m = /^status\.type (is|is not) (todo|done|in_progress|cancelled)$/.exec(lower);
  if (m) {
    const want = m[2].toUpperCase();
    return m[1] === "is" ? (t) => t.status === want : (t) => t.status !== want;
  }
  m = /^tags (include|do not include) (.+)$/.exec(lower);
  if (m) {
    const [, op, v] = m;
    const tag = v.replace(/^#?/, "#");
    const has = (t: Task) => t.tags.some((x) => x.toLowerCase().includes(tag));
    return op === "include" ? has : (t) => !has(t);
  }
  m = /^(description|path|folder|filename|heading|tag|tags) (includes|does not include) (.+)$/i.exec(line);
  if (m) {
    const [, f, op, v] = m;
    const needle = v.toLowerCase();
    const has = (t: Task) => textOf(t, f.toLowerCase()).some((s) => s.toLowerCase().includes(needle));
    return op.toLowerCase() === "includes" ? has : (t) => !has(t);
  }
  m = /^(description|path|folder|filename|heading|tag|tags) (regex matches|regex does not match) (.+)$/i.exec(line);
  if (m) {
    const [, f, op, v] = m;
    const re = regexOf(v);
    if (!re) return { code: "regex", text: v };
    const has = (t: Task) => textOf(t, f.toLowerCase()).some((s) => re.test(s));
    return op.toLowerCase() === "regex matches" ? has : (t) => !has(t);
  }
  return { code: "query", text: line };
}

export function parseQuery(source: string, today = new Date()): TaskQuery {
  const q: TaskQuery = { filters: [], sorts: [], group: null, limit: null, hide: new Set(), errors: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const lower = line.toLowerCase();
    let m = /^sort by (due|scheduled|start|done|created|priority|description|path|status|urgency|filename|heading)(?: (reverse))?$/.exec(lower);
    if (m) {
      q.sorts.push({ key: m[1] as SortKey, reverse: !!m[2] });
      continue;
    }
    m = /^group by (due|scheduled|priority|path|folder|filename|heading|status|tags)$/.exec(lower);
    if (m) {
      q.group = m[1] as GroupKey;
      continue;
    }
    m = /^limit(?: to)? (\d+)(?: tasks?)?$/.exec(lower);
    if (m) {
      q.limit = Number(m[1]);
      continue;
    }
    m = /^(hide|show) (.+)$/.exec(lower);
    if (m) {
      if (m[1] === "hide") q.hide.add(m[2]);
      else q.hide.delete(m[2]);
      continue;
    }
    if (lower === "short mode" || lower === "explain") continue;
    const f = parseFilter(line, today);
    if (isError(f)) q.errors.push(f);
    else q.filters.push(f);
  }
  return q;
}

/** Upstream urgency, simplified: due date nearness + priority. */
export function urgency(t: Task, today: Date): number {
  let u = [9, 6, 3.9, 1.95, 0, 1.95 * 0][PRIORITY_RANK[t.priority]] ?? 0;
  if (t.priority === "low") u = 0;
  if (t.priority === "lowest") u = -1.8;
  if (t.due) {
    const days = Math.round((Date.parse(t.due) - Date.parse(iso(today))) / 86_400_000);
    u += days >= 14 ? 2.4 : days <= -7 ? 12 : 12 - ((days + 7) / 21) * 9.6;
  }
  if (t.scheduled && t.scheduled <= iso(today)) u += 5;
  if (t.start && t.start > iso(today)) u -= 3;
  return u;
}

const STATUS_RANK = { IN_PROGRESS: 0, TODO: 1, DONE: 2, CANCELLED: 3, NON_TASK: 4 } as const;

function sortValue(t: Task, k: SortKey, today: Date): string | number {
  switch (k) {
    case "priority":
      return PRIORITY_RANK[t.priority];
    case "status":
      return STATUS_RANK[t.status];
    case "urgency":
      return -urgency(t, today);
    case "description":
      return t.description.toLowerCase();
    case "path":
      return t.path;
    case "filename":
      return fileOf(t.path);
    case "heading":
      return t.heading ?? "";
    default:
      // Tasks without the date go last, as upstream.
      return t[k] ?? "9999-99-99";
  }
}

/**
 * A group a task falls in: the key it sorts by, and its name. Names the UI
 * translates ("none", "done", "todo") come as a `label` instead of text, so
 * nothing English is made in the worker. Groups without a value sort last.
 */
interface GroupOf {
  key: string;
  name: string;
  label?: GroupLabel;
}
export type GroupLabel = "none" | "done" | "todo";

const LAST = "\uffff";
const PRIORITY_SYMBOL: Record<Priority, string> = { highest: "🔺", high: "⏫", medium: "🔼", none: "", low: "🔽", lowest: "⏬" };

function groupValue(t: Task, g: GroupKey): GroupOf[] {
  const none: GroupOf = { key: LAST, name: "", label: "none" };
  switch (g) {
    case "due":
    case "scheduled": {
      const d = t[g];
      return [d ? { key: d, name: d } : none];
    }
    case "priority": {
      const rank = String(PRIORITY_RANK[t.priority]);
      return [t.priority === "none" ? { ...none, key: rank } : { key: rank, name: PRIORITY_SYMBOL[t.priority] }];
    }
    case "path":
      return [{ key: t.path, name: t.path.replace(/\.md$/, "") }];
    case "folder":
      return [{ key: folderOf(t.path), name: folderOf(t.path) }];
    case "filename": {
      const f = fileOf(t.path).replace(/\.md$/, "");
      return [{ key: f, name: f }];
    }
    case "heading":
      return [t.heading ? { key: t.heading, name: t.heading } : none];
    case "status":
      return [t.status === "DONE" || t.status === "CANCELLED" ? { key: "1", name: "", label: "done" } : { key: "0", name: "", label: "todo" }];
    case "tags":
      return t.tags.length ? t.tags.map((tag) => ({ key: tag, name: tag })) : [none];
  }
}

export interface QueryResult {
  groups: Array<{ name: string; label?: GroupLabel; tasks: Task[] }>;
  total: number;
  errors: QueryError[];
}

/** Run a query. Default sort as upstream: status, urgency, due, priority, path. */
export function runQuery(q: TaskQuery, all: Task[], today = new Date()): QueryResult {
  if (q.errors.length) return { groups: [], total: 0, errors: q.errors };
  let hits = all.filter((t) => q.filters.every((f) => f(t, all)));
  const sorts = [...q.sorts, { key: "status" as SortKey, reverse: false }, { key: "urgency" as SortKey, reverse: false }, { key: "due" as SortKey, reverse: false }, { key: "priority" as SortKey, reverse: false }, { key: "path" as SortKey, reverse: false }];
  const cache = new Map<Task, Map<SortKey, string | number>>();
  const val = (t: Task, k: SortKey) => {
    let c = cache.get(t);
    if (!c) cache.set(t, (c = new Map()));
    if (!c.has(k)) c.set(k, sortValue(t, k, today));
    return c.get(k)!;
  };
  hits.sort((a, b) => {
    for (const s of sorts) {
      const x = val(a, s.key);
      const y = val(b, s.key);
      if (x !== y) return (x < y ? -1 : 1) * (s.reverse ? -1 : 1);
    }
    return a.line - b.line;
  });
  const total = hits.length;
  if (q.limit !== null) hits = hits.slice(0, q.limit);
  if (!q.group) return { groups: [{ name: "", tasks: hits }], total, errors: [] };
  const groups = new Map<string, { name: string; label?: GroupLabel; tasks: Task[] }>();
  for (const t of hits) {
    for (const g of groupValue(t, q.group)) {
      let group = groups.get(g.key);
      if (!group) groups.set(g.key, (group = g.label ? { name: g.name, label: g.label, tasks: [] } : { name: g.name, tasks: [] }));
      group.tasks.push(t);
    }
  }
  return { groups: [...groups].sort(([a], [b]) => (a === b ? 0 : a === LAST ? 1 : b === LAST ? -1 : a.localeCompare(b))).map(([, g]) => g), total, errors: [] };
}
