/**
 * Run a bulk property edit over the vault (plan W7.4) and undo it as one
 * action. Each note is written through `editNote` (the open note through its
 * editor, any other note through the vault's atomic save, plan W1.5), a few
 * at a time. What every note held before is kept in memory, so one Undo (the
 * toast's button, or Ctrl+Z outside an editor) puts every note back, unless
 * it changed again since: such a note is left as it now is, and counted.
 */
import { applyBulkOp, type BulkChange, type BulkOp, type BulkSkip } from "./bulkEdit";
import { editNote } from "./databaseEdit";
import { readWorkspaceTexts, writeWorkspaceFilesIf, type FileStamp } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { useAppStore } from "../store/useStore";

export interface BulkRunResult {
  changes: BulkChange[];
  skipped: Array<{ path: string; why: BulkSkip | "failed" }>;
  ms: number;
  /** Where the time went (ms): the batch read, computing, the writes, and the notes done one by one. */
  phases: Phases;
}

export interface Phases {
  read: number;
  compute: number;
  write: number;
  slow: number;
}

/** Notes written at the same time (each note's own writes stay in order: editNote queues them). */
const CONCURRENCY = 32;

/** Notes open in the editor or in a tab: they go through editNote, so the editor and the tab see the change. */
function openPaths(): Set<string> {
  const { doc, openTabs } = useAppStore.getState();
  const out = new Set<string>();
  if (doc.workspaceName) out.add(doc.workspaceName);
  for (const t of openTabs) if (t.workspaceName) out.add(t.workspaceName);
  return out;
}

/**
 * Apply `edit` to many notes fast (plan W7.4): the closed ones are read in
 * one batch (readWorkspaceTexts), computed, and written back only if the
 * file is still what was read (writeWorkspaceFileIf, under the path's
 * lock); a note that changed in between, or is open, takes the one-by-one
 * path (editNote), which reads it again. One change event for the batch.
 */
async function editMany(
  paths: readonly string[],
  edit: (text: string, path: string) => string | null,
  onProgress?: (done: number, total: number) => void,
  phases: Phases = { read: 0, compute: 0, write: 0, slow: 0 },
): Promise<Map<string, { before: string; after: string } | "unchanged" | "failed">> {
  let t = performance.now();
  const lap = (k: keyof Phases) => {
    const now = performance.now();
    phases[k] += now - t;
    t = now;
  };
  const result = new Map<string, { before: string; after: string } | "unchanged" | "failed">();
  const open = openPaths();
  const closed = paths.filter((p) => !open.has(p));
  const read = await readWorkspaceTexts(closed);
  lap("read");
  const slow: string[] = paths.filter((p) => open.has(p) || !read.has(p));
  const written: string[] = [];
  let done = 0;
  const tick = () => onProgress?.(++done, paths.length);
  const todo: Array<{ p: string; before: string; after: string; stamp: FileStamp }> = [];
  for (const p of closed) {
    const r = read.get(p);
    if (!r) continue;
    const after = edit(r.text, p);
    if (after === null || after === r.text) {
      result.set(p, "unchanged");
      tick();
    } else todo.push({ p, before: r.text, after, stamp: r.stamp });
  }
  lap("compute");
  const wrote = await writeWorkspaceFilesIf(todo.map((j) => ({ path: j.p, content: j.after, expect: j.stamp })));
  for (const job of todo) {
    const r = wrote.get(job.p);
    if (r === true) {
      result.set(job.p, { before: job.before, after: job.after });
      written.push(job.p);
      tick();
    } else if (r instanceof Error) {
      result.set(job.p, "failed");
      tick();
    } else slow.push(job.p);
  }
  if (written.length) notifyWorkspaceChanged({ kind: "content", paths: written });
  lap("write");
  await pool(slow, CONCURRENCY, async (p) => {
    let rec: { before: string; after: string } | null = null;
    try {
      const changed = await editNote(p, (text) => {
        const after = edit(text, p);
        rec = after === null ? null : { before: text, after };
        return after ?? text;
      });
      const r = rec as { before: string; after: string } | null;
      result.set(p, changed && r && r.after !== r.before ? r : "unchanged");
    } catch {
      // why: reported with the notes that could not be written
      result.set(p, "failed");
    }
    tick();
  });
  lap("slow");
  return result;
}

async function pool<T>(items: readonly T[], n: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await job(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export async function runBulkEdit(paths: readonly string[], op: BulkOp, onProgress?: (done: number, total: number) => void): Promise<BulkRunResult> {
  const start = performance.now();
  const why = new Map<string, BulkSkip>();
  const phases: Phases = { read: 0, compute: 0, write: 0, slow: 0 };
  const res = await editMany(
    paths,
    (text, path) => {
      const r = applyBulkOp(text, op);
      if (r.skip) {
        why.set(path, r.skip);
        return null;
      }
      why.delete(path);
      return r.text;
    },
    onProgress,
    phases,
  );
  const changes: BulkChange[] = [];
  const skipped: BulkRunResult["skipped"] = [];
  for (const p of paths) {
    const r = res.get(p);
    if (r && typeof r === "object") changes.push({ path: p, before: r.before, after: r.after });
    else skipped.push({ path: p, why: r === "failed" ? "failed" : (why.get(p) ?? "unchanged") });
  }
  const result = { changes, skipped, ms: performance.now() - start, phases };
  if (changes.length) remember(changes);
  return result;
}

interface UndoEntry {
  at: number;
  changes: BulkChange[];
}

const stack: UndoEntry[] = [];
const LIMIT = 20;

function remember(changes: BulkChange[]): void {
  stack.push({ at: Date.now(), changes });
  if (stack.length > LIMIT) stack.splice(0, stack.length - LIMIT);
}

/** When the newest bulk edit that can still be undone happened, or 0. */
export function lastBulkEditAt(): number {
  return stack.length ? stack[stack.length - 1].at : 0;
}

export interface BulkUndoResult {
  restored: number;
  /** Notes that changed again after the edit: left as they are. */
  conflicts: string[];
}

/** Put every note of one edit back. */
export async function undoBulkChanges(changes: readonly BulkChange[]): Promise<BulkUndoResult> {
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const clash = new Set<string>();
  const res = await editMany(
    changes.map((c) => c.path),
    (text, path) => {
      const c = byPath.get(path)!;
      if (text === c.after) {
        clash.delete(path);
        return c.before;
      }
      if (text !== c.before) clash.add(path);
      return null;
    },
  );
  let restored = 0;
  const conflicts: string[] = [];
  for (const c of changes) {
    const r = res.get(c.path);
    if (r && typeof r === "object") restored++;
    else if (r === "failed" || clash.has(c.path)) conflicts.push(c.path);
  }
  const i = stack.findIndex((e) => e.changes === changes);
  if (i >= 0) stack.splice(i, 1);
  return { restored, conflicts: conflicts.sort() };
}

/** Ctrl+Z outside an editor: undo the newest bulk edit. Null when there is none. */
export async function undoLastBulkEdit(): Promise<BulkUndoResult | null> {
  const top = stack[stack.length - 1];
  return top ? undoBulkChanges(top.changes) : null;
}

/** Test hook. */
export function __resetBulkUndo(): void {
  stack.length = 0;
}
