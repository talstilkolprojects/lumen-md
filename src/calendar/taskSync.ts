/**
 * Two-way sync of the vault's tasks with a CalDAV calendar (plan W7.20).
 *
 * - Which tasks: `- [ ]` tasks with a date (📅 due, or ⏳ scheduled; 4.13), and
 *   any task that already has a calendar id. A task that arrives from the
 *   server is added to the inbox note.
 * - The id: a hidden comment at the end of the line, `<!-- lumen-caldav:UID -->`,
 *   which Markdown readers don't show and which survives edits to the text.
 * - Three-way: each side is compared with what both agreed on last time
 *   (`SyncState`). One side changed: it wins. Both changed to different
 *   things: a conflict, shown with both versions, never overwritten silently.
 *   A delete on one side and an edit on the other is a conflict too.
 *
 * Pure planning (`planSync`) and line edits (`applyLocal`) are separate from
 * the I/O (`runSync`), so the planner is tested on its own and the whole loop
 * runs against a fake server and against a real Radicale.
 */
import { parseTaskLine, serializeTask, tasksInNote, type Task } from "../tasks/taskParser";
import { parseTodos, todoToIcs, type Todo } from "./ical";
import { CalDavError, type CalDavClient } from "./caldav";

export const ID_COMMENT = / ?<!-- lumen-caldav:([A-Za-z0-9._@-]+) -->/;

export interface LocalTask {
  uid: string | null;
  path: string;
  line: number;
  todo: Omit<Todo, "uid">;
}

export interface RemoteTask {
  uid: string;
  href: string;
  etag: string;
  todo: Omit<Todo, "uid">;
}

export interface BaseEntry {
  href: string;
  etag: string;
  /** The content both sides had after the last sync. */
  hash: string;
}

export interface SyncState {
  v: 1;
  entries: Record<string, BaseEntry>;
}

export const emptyState = (): SyncState => ({ v: 1, entries: {} });

/**
 * What a task means to the calendar: text, dates, done. The completion date is
 * left out: a note's `- [x]` may have none and the server always stamps one.
 */
export function hashTodo(t: Omit<Todo, "uid">): string {
  return JSON.stringify([t.summary.trim(), t.due, t.start, t.completed]);
}

function todoOfTask(t: Task): Omit<Todo, "uid"> {
  return { summary: t.description, due: t.due ?? t.scheduled, start: t.start, completed: t.status === "DONE", completedOn: t.status === "DONE" ? t.done : null };
}

/** The synced tasks of one note. A uid seen twice (a copied line) keeps only its first line; the copy is new. */
export function localTasksOf(path: string, content: string, seen = new Set<string>()): LocalTask[] {
  const lines = content.split(/\r?\n/);
  const uids = lines.map((l) => ID_COMMENT.exec(l)?.[1] ?? null);
  const clean = lines.map((l) => l.replace(ID_COMMENT, "")).join("\n");
  const out: LocalTask[] = [];
  for (const t of tasksInNote(path, clean)) {
    if (t.status === "NON_TASK" || t.status === "CANCELLED") continue;
    let uid = uids[t.line];
    if (uid && seen.has(uid)) uid = null;
    if (!uid && !t.due && !t.scheduled) continue;
    if (uid) seen.add(uid);
    out.push({ uid, path, line: t.line, todo: todoOfTask(t) });
  }
  return out;
}

export function remoteTasksOf(resources: ReadonlyArray<{ href: string; etag: string; ics: string }>): RemoteTask[] {
  const out: RemoteTask[] = [];
  const seen = new Set<string>();
  for (const r of resources) {
    for (const t of parseTodos(r.ics)) {
      if (seen.has(t.uid)) continue;
      seen.add(t.uid);
      const { uid, ...todo } = t;
      out.push({ uid, href: r.href, etag: r.etag, todo });
    }
  }
  return out;
}

export type Action =
  | { kind: "push-create"; local: LocalTask }
  | { kind: "push-update"; uid: string; local: LocalTask; remote: RemoteTask }
  | { kind: "push-delete"; uid: string; remote: RemoteTask }
  | { kind: "pull-create"; remote: RemoteTask }
  | { kind: "pull-update"; uid: string; local: LocalTask; remote: RemoteTask }
  | { kind: "pull-delete"; uid: string; local: LocalTask }
  | { kind: "agree"; uid: string; local: LocalTask | null; remote: RemoteTask | null }
  | { kind: "forget"; uid: string }
  | { kind: "conflict"; uid: string; local: LocalTask | null; remote: RemoteTask | null; why: "both-changed" | "deleted-here-changed-there" | "changed-here-deleted-there" };

export type Conflict = Extract<Action, { kind: "conflict" }>;

export function planSync(local: readonly LocalTask[], remote: readonly RemoteTask[], state: SyncState): Action[] {
  const actions: Action[] = [];
  const L = new Map<string, LocalTask>();
  for (const t of local) if (t.uid) L.set(t.uid, t);
  const R = new Map(remote.map((r) => [r.uid, r]));
  for (const t of local) if (!t.uid) actions.push({ kind: "push-create", local: t });
  const uids = new Set([...L.keys(), ...R.keys(), ...Object.keys(state.entries)]);
  for (const uid of [...uids].sort()) {
    const l = L.get(uid) ?? null;
    const r = R.get(uid) ?? null;
    const b = state.entries[uid] ?? null;
    const lh = l ? hashTodo(l.todo) : null;
    const rh = r ? hashTodo(r.todo) : null;
    if (!b) {
      if (l && r) actions.push(lh === rh ? { kind: "agree", uid, local: l, remote: r } : { kind: "conflict", uid, local: l, remote: r, why: "both-changed" });
      else if (l) actions.push({ kind: "push-create", local: l });
      else if (r) actions.push({ kind: "pull-create", remote: r });
      continue;
    }
    const lChanged = l ? lh !== b.hash : true;
    const rChanged = r ? rh !== b.hash : true;
    if (!l && !r) actions.push({ kind: "forget", uid });
    else if (!l && r) actions.push(rChanged ? { kind: "conflict", uid, local: null, remote: r, why: "deleted-here-changed-there" } : { kind: "push-delete", uid, remote: r });
    else if (l && !r) actions.push(lChanged ? { kind: "conflict", uid, local: l, remote: null, why: "changed-here-deleted-there" } : { kind: "pull-delete", uid, local: l });
    else if (l && r) {
      if (lh === rh) {
        if (lh !== b.hash || r.etag !== b.etag) actions.push({ kind: "agree", uid, local: l, remote: r });
      } else if (lChanged && rChanged) actions.push({ kind: "conflict", uid, local: l, remote: r, why: "both-changed" });
      else if (lChanged) actions.push({ kind: "push-update", uid, local: l, remote: r });
      else actions.push({ kind: "pull-update", uid, local: l, remote: r });
    }
  }
  return actions;
}

export type Choice = "here" | "there" | "both";

/** The dialog's answer as actions: keep this device's version, the server's, or both (the server's becomes a new task here). */
export function resolveConflict(c: Conflict, choice: Choice): Action[] {
  const { uid, local: l, remote: r } = c;
  if (choice === "here") {
    if (l && r) return [{ kind: "push-update", uid, local: l, remote: r }];
    if (l) return [{ kind: "push-create", local: l }];
    return r ? [{ kind: "push-delete", uid, remote: r }] : [];
  }
  if (choice === "there") {
    if (l && r) return [{ kind: "pull-update", uid, local: l, remote: r }];
    if (r) return [{ kind: "pull-create", remote: r }];
    return l ? [{ kind: "pull-delete", uid, local: l }] : [];
  }
  // Both: this device's line gets a new id and goes up as a new task; the server's keeps its id and comes down as a new line.
  const out: Action[] = [];
  if (l) out.push({ kind: "push-create", local: { ...l, uid: null } });
  if (r) out.push({ kind: "pull-create", remote: r });
  return out;
}

// ------------------------------------------------------------ local edits

export const withId = (line: string, uid: string): string => `${line.replace(ID_COMMENT, "")} <!-- lumen-caldav:${uid} -->`;

/** The line for a task from the server, or the existing line with the server's text, dates and state. */
export function taskLine(todo: Omit<Todo, "uid">, uid: string, existing?: string): string {
  const base = existing ? parseTaskLine(existing.replace(ID_COMMENT, "")) : null;
  const t: Task = base ?? parseTaskLine("- [ ] x")!;
  const keepScheduled = !!base && !base.due && !!base.scheduled;
  const next: Task = {
    ...t,
    description: todo.summary.replace(/\r?\n/g, " ").trim(),
    due: keepScheduled ? null : todo.due,
    scheduled: keepScheduled ? todo.due : base?.scheduled ?? null,
    start: todo.start,
    status: todo.completed ? "DONE" : "TODO",
    symbol: todo.completed ? "x" : " ",
    done: todo.completed ? todo.completedOn : null,
  };
  const marker = existing ? (/^[\s>]*([-*+]|\d+[.)])/.exec(existing)?.[1] ?? "-") : "-";
  return withId(serializeTask(next, marker), uid);
}

export type LineEdit =
  | { path: string; uid: string; op: "set"; line: string }
  | { path: string; uid: string; op: "delete" }
  | { path: string; uid: string; op: "append"; line: string }
  /** Give the task on this line number this id (replacing an old one). */
  | { path: string; uid: string; op: "tag"; line: number };

/** Applies edits to one note's text, finding lines by their id (line numbers move between edits). */
export function applyLocal(content: string, edits: readonly LineEdit[]): string {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  let lines = content.split(/\r?\n/);
  const at = (uid: string) => lines.findIndex((l) => ID_COMMENT.exec(l)?.[1] === uid);
  for (const e of edits) {
    if (e.op === "tag") {
      if (e.line >= 0 && e.line < lines.length) lines[e.line] = withId(lines[e.line], e.uid);
    } else if (e.op === "append") {
      if (at(e.uid) >= 0) continue;
      if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, e.line);
      else lines.push(e.line);
    } else {
      const i = at(e.uid);
      if (i < 0) continue;
      if (e.op === "delete") lines = lines.slice(0, i).concat(lines.slice(i + 1));
      else lines[i] = e.line;
    }
  }
  return lines.join(nl);
}

// ------------------------------------------------------------ the loop

export interface VaultIO {
  list(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export interface SyncOptions {
  vault: VaultIO;
  client: CalDavClient;
  state: SyncState;
  /** Where tasks that come from the server are added. */
  inbox: string;
  newUid: () => string;
  now: () => Date;
  /** Answers conflicts; without it they are returned unresolved and nothing of theirs is touched. */
  decide?: (c: Conflict) => Promise<Choice | null>;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: Conflict[];
  errors: string[];
  state: SyncState;
}

export async function collectLocal(vault: VaultIO): Promise<{ tasks: LocalTask[]; contents: Map<string, string> }> {
  const contents = new Map<string, string>();
  const tasks: LocalTask[] = [];
  const seen = new Set<string>();
  for (const path of (await vault.list()).filter((p) => p.endsWith(".md")).sort()) {
    const c = await vault.read(path);
    if (c === null) continue;
    contents.set(path, c);
    tasks.push(...localTasksOf(path, c, seen));
  }
  return { tasks, contents };
}

export async function runSync(o: SyncOptions): Promise<SyncReport> {
  const state: SyncState = { v: 1, entries: { ...o.state.entries } };
  const report: SyncReport = { pushed: 0, pulled: 0, deleted: 0, conflicts: [], errors: [], state };
  const { tasks, contents } = await collectLocal(o.vault);
  const remote = remoteTasksOf(await o.client.list());
  let actions = planSync(tasks, remote, state);
  const resolved: Action[] = [];
  for (const a of actions) {
    if (a.kind !== "conflict") {
      resolved.push(a);
      continue;
    }
    const choice = o.decide ? await o.decide(a) : null;
    if (choice) resolved.push(...resolveConflict(a, choice));
    else report.conflicts.push(a);
  }
  actions = resolved;
  const edits = new Map<string, LineEdit[]>();
  const edit = (e: LineEdit) => edits.set(e.path, [...(edits.get(e.path) ?? []), e]);
  const ics = (uid: string, todo: Omit<Todo, "uid">) => todoToIcs({ uid, ...todo }, o.now());
  for (const a of actions) {
    try {
      switch (a.kind) {
        case "push-create": {
          const uid = a.local.uid ?? o.newUid();
          const { href, etag } = await o.client.create(`${uid}.ics`, ics(uid, a.local.todo));
          state.entries[uid] = { href, etag, hash: hashTodo(a.local.todo) };
          if (a.local.uid !== uid) edit({ path: a.local.path, uid, op: "tag", line: a.local.line });
          report.pushed++;
          break;
        }
        case "push-update": {
          const { etag } = await o.client.update(a.remote.href, ics(a.uid, a.local.todo), a.remote.etag);
          state.entries[a.uid] = { href: a.remote.href, etag, hash: hashTodo(a.local.todo) };
          report.pushed++;
          break;
        }
        case "push-delete":
          await o.client.remove(a.remote.href, a.remote.etag);
          delete state.entries[a.uid];
          report.deleted++;
          break;
        case "pull-create":
          edit({ path: o.inbox, uid: a.remote.uid, op: "append", line: taskLine(a.remote.todo, a.remote.uid) });
          state.entries[a.remote.uid] = { href: a.remote.href, etag: a.remote.etag, hash: hashTodo(a.remote.todo) };
          report.pulled++;
          break;
        case "pull-update": {
          const existing = (contents.get(a.local.path) ?? "").split(/\r?\n/)[a.local.line];
          edit({ path: a.local.path, uid: a.uid, op: "set", line: taskLine(a.remote.todo, a.uid, existing) });
          state.entries[a.uid] = { href: a.remote.href, etag: a.remote.etag, hash: hashTodo(a.remote.todo) };
          report.pulled++;
          break;
        }
        case "pull-delete":
          edit({ path: a.local.path, uid: a.uid, op: "delete" });
          delete state.entries[a.uid];
          report.deleted++;
          break;
        case "agree":
          if (a.remote) state.entries[a.uid] = { href: a.remote.href, etag: a.remote.etag, hash: hashTodo(a.remote.todo) };
          if (a.local && !contents.get(a.local.path)?.split(/\r?\n/)[a.local.line]?.match(ID_COMMENT)) edit({ path: a.local.path, uid: a.uid, op: "tag", line: a.local.line });
          break;
        case "forget":
          delete state.entries[a.uid];
          break;
      }
    } catch (e) {
      // A 412 means the server changed since the list: the next sync sees it (and shows the conflict if there is one).
      report.errors.push(e instanceof CalDavError ? `${a.kind}: ${e.kind} (${e.status})` : `${a.kind}: ${String(e).slice(0, 160)}`);
    }
  }
  for (const [path, es] of edits) {
    // Tags first, by line number, while the numbers still hold.
    const tags = es.filter((e) => e.op === "tag");
    const rest = es.filter((e) => e.op !== "tag");
    const before = contents.get(path) ?? (await o.vault.read(path)) ?? "";
    const after = applyLocal(before, [...tags, ...rest]);
    if (after !== before) await o.vault.write(path, after);
  }
  return report;
}
