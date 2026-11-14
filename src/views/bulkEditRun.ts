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

export interface BulkRunResult {
  changes: BulkChange[];
  skipped: Array<{ path: string; why: BulkSkip | "failed" }>;
  ms: number;
}

/** Notes written at the same time (each note's own writes stay in order: editNote queues them). */
const CONCURRENCY = 16;

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
  const changes: BulkChange[] = [];
  const skipped: BulkRunResult["skipped"] = [];
  let done = 0;
  await pool(paths, CONCURRENCY, async (path) => {
    // editNote runs the edit on open tabs' copies first and on the file's text last: the last call is the file.
    let last: { before: string; after: string; skip?: BulkSkip } | null = null;
    try {
      const changed = await editNote(path, (text) => {
        const r = applyBulkOp(text, op);
        last = { before: text, after: r.text, skip: r.skip };
        return r.text;
      });
      const rec = last as { before: string; after: string; skip?: BulkSkip } | null;
      if (changed && rec && !rec.skip) changes.push({ path, before: rec.before, after: rec.after });
      else skipped.push({ path, why: rec?.skip ?? "unchanged" });
    } catch {
      // why: one unreadable note must not stop the others; it is reported in the result
      skipped.push({ path, why: "failed" });
    }
    onProgress?.(++done, paths.length);
  });
  const result = { changes, skipped, ms: performance.now() - start };
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
  const conflicts: string[] = [];
  let restored = 0;
  await pool(changes, CONCURRENCY, async (c) => {
    let clash = false;
    try {
      const changed = await editNote(c.path, (text) => {
        if (text === c.after) return c.before;
        clash = text !== c.before;
        return text;
      });
      if (changed) restored++;
      else if (clash) conflicts.push(c.path);
    } catch {
      // why: reported with the notes that could not be put back
      conflicts.push(c.path);
    }
  });
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
