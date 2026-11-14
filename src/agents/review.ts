/**
 * The review panel's logic (plan 5.11), kept apart from the component so
 * it is tested on its own: the queue grouped by the run that proposed
 * each change, the diffs the panel shows, and approve / reject all.
 *
 * Diffs reuse the Myers line diff of `git_diff` (lib/lineDiff.ts): line by
 * line for a whole file, word by word for a range of the open document,
 * which the panel draws with the editor's suggestion marks (insertions
 * underlined in green, deletions struck through in red).
 */

import { diffLines, linesWithEol, NO_EOL } from "../lib/lineDiff";
import { approveStagedChange, rejectStagedChange } from "./staging";
import type { StagedChange } from "./types";

export interface RunGroup {
  /** The run id, or the change id for a change staged outside a run. */
  key: string;
  runId?: string;
  agentId?: string;
  createdAt: number;
  changes: StagedChange[];
}

export interface ReviewModel {
  /** Pending changes by run, oldest run first; the changes in proposal order. */
  pending: RunGroup[];
  pendingCount: number;
  /** Settled changes (applied, rejected, conflict, withdrawn), newest first. */
  settled: StagedChange[];
}

export function reviewModel(list: readonly StagedChange[], settledLimit = 20): ReviewModel {
  const groups = new Map<string, RunGroup>();
  let pendingCount = 0;
  for (const c of list) {
    if (c.status !== "pending") continue;
    pendingCount++;
    const key = c.runId ?? c.id;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, runId: c.runId, agentId: c.agentId, createdAt: c.createdAt, changes: [] }));
    g.changes.push(c);
  }
  const settled = list.filter((c) => c.status !== "pending").sort((a, b) => b.createdAt - a.createdAt).slice(0, settledLimit);
  return { pending: [...groups.values()].sort((a, b) => a.createdAt - b.createdAt), pendingCount, settled };
}

export type DiffRow =
  /** `noEol`: the line is the file's last and has no newline after it (git's "\ No newline at end of file"). */
  | { op: "eq" | "add" | "del"; text: string; a?: number; b?: number; noEol?: true }
  /** Unchanged lines left out between hunks. */
  | { op: "gap"; skipped: number };

/**
 * A file change as diff rows: changed lines with `context` unchanged lines
 * around them; longer unchanged runs collapse into a gap. Null when the
 * diff is too large to show line by line (the panel says so). The final
 * newline counts, as in `unifiedDiff`: adding or removing only it changes
 * the last line, which is then marked `noEol` on the side that lacks it.
 */
export function lineDiffRows(before: string | null, after: string, context = 2, maxEdits = 2000): DiffRow[] | null {
  const a = linesWithEol(before);
  const b = linesWithEol(after);
  const ops = diffLines(a, b, maxEdits);
  if (!ops) return null;
  const rows: DiffRow[] = [];
  let ai = 1;
  let bi = 1;
  const numbered = ops.map((o) => {
    const noEol = o.line.endsWith(NO_EOL);
    const line = noEol ? o.line.slice(0, -NO_EOL.length) : o.line;
    // A CRLF line keeps its CR (LF ↔ CRLF is a change); shown as ^M, as unifiedDiff prints it.
    const text = line.endsWith("\r") ? `${line.slice(0, -1)}^M` : line;
    const row: Exclude<DiffRow, { op: "gap" }> = { op: o.op, text, a: o.op !== "add" ? ai : undefined, b: o.op !== "del" ? bi : undefined };
    if (noEol) row.noEol = true;
    if (o.op !== "add") ai++;
    if (o.op !== "del") bi++;
    return row;
  });
  const near = numbered.map(() => false);
  numbered.forEach((r, i) => {
    if (r.op === "eq") return;
    for (let j = Math.max(0, i - context); j <= Math.min(numbered.length - 1, i + context); j++) near[j] = true;
  });
  let skipped = 0;
  numbered.forEach((r, i) => {
    if (r.op === "eq" && !near[i]) {
      skipped++;
      return;
    }
    if (skipped) rows.push({ op: "gap", skipped });
    skipped = 0;
    rows.push(r);
  });
  if (skipped) rows.push({ op: "gap", skipped });
  return rows;
}

export interface InlinePart {
  op: "eq" | "add" | "del";
  text: string;
}

const TOKEN = /\s+|[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu;

/**
 * The replaced text and its replacement as one inline, word-level diff:
 * within each changed stretch the removed words come first, then the
 * added ones (how a tracked change reads).
 */
export function inlineDiff(before: string, after: string): InlinePart[] {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  const ops = diffLines(a, b, 4000);
  if (!ops) return [...(before ? [{ op: "del" as const, text: before }] : []), ...(after ? [{ op: "add" as const, text: after }] : [])];
  const parts: InlinePart[] = [];
  const push = (op: InlinePart["op"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.op === op) last.text += text;
    else parts.push({ op, text });
  };
  let del = "";
  let add = "";
  const flush = () => {
    push("del", del);
    push("add", add);
    del = add = "";
  };
  for (const o of ops) {
    if (o.op === "eq") {
      flush();
      push("eq", o.line);
    } else if (o.op === "del") del += o.line;
    else add += o.line;
  }
  flush();
  return parts;
}

/**
 * The order to approve several changes in: file changes as proposed, then
 * range changes from the end of the text backwards. Offsets are mapped
 * through earlier approvals anyway (staging's `locateRange`); a fixed order
 * keeps "approve all" deterministic.
 */
export function approvalOrder(changes: readonly StagedChange[]): StagedChange[] {
  const files = changes.filter((c) => c.kind === "file").sort((x, y) => x.createdAt - y.createdAt);
  const ranges = changes.filter((c) => c.kind === "range").sort((x, y) => (y as { from: number }).from - (x as { from: number }).from);
  return [...files, ...ranges];
}

/** Approve every given pending change, one after another (see `approvalOrder`). */
export async function approveAll(changes: readonly StagedChange[], approve: (id: string) => Promise<StagedChange> = approveStagedChange): Promise<StagedChange[]> {
  const out: StagedChange[] = [];
  for (const c of approvalOrder(changes.filter((x) => x.status === "pending"))) out.push(await approve(c.id));
  return out;
}

export function rejectAll(changes: readonly StagedChange[]): number {
  let n = 0;
  for (const c of changes) if (c.status === "pending" && rejectStagedChange(c.id)?.status === "rejected") n++;
  return n;
}
