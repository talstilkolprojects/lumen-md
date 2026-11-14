/**
 * Staged changes — what agent write tools produce instead of writing.
 *
 * An agent never changes a file or the open document by itself. A write
 * tool (`write_file`, `set_frontmatter`, `replace_range`) computes the
 * change and the runtime stages it here; the user approves or rejects it,
 * and only an approval writes. The run's trace lists the staged ids
 * (`AgentRun.staged`), so every proposal can be traced to the run, the
 * agent and the tool call that made it.
 *
 * Two kinds:
 *   file   create / overwrite a workspace file. Approving writes it, but
 *          only if the file still has the content the change was computed
 *          from (`before`); otherwise the change is marked `conflict` and
 *          nothing is written.
 *   range  replace [from, to) of the open document. When the text is still
 *          the one the change was computed on (`basis`), possibly with
 *          other approved changes applied since, the offsets are exact
 *          (mapped through those). Otherwise the text at [from, to) must
 *          still be `before` with its surroundings (`context`) — when it
 *          moved, the single place where they occur is used instead;
 *          otherwise `conflict` (`locateRange`).
 *
 * Both kinds go to the document applier the editor registers
 * (`setDocumentApplier`, `documentApplier.ts`) first: a change to a
 * document that is open — the active one or another tab — is applied to
 * its live text (unsaved edits included, undo in the source editor), not
 * to the file underneath it. The applier answers `null` for a document
 * that is not open, and the change goes to its workspace file instead.
 *
 * The queue lives in memory for the session (a proposal is only meaningful
 * against the document it was computed from) and is capped; listeners
 * (the review panel, `ui/AgentReviewPanel.tsx`) are told about every
 * change. A run that is cancelled withdraws its pending proposals
 * (`discardRunChanges`).
 */

import type { ChangeProposal, RangeContext, StagedChange, StagedConflict, StagedReceipt } from "./types";

const MAX_CHANGES = 200;

let changes: StagedChange[] = [];
let seq = 0;
const listeners = new Set<(list: readonly StagedChange[]) => void>();

/**
 * What the editor's applier reports for an approved change:
 *   true / { ok: true }   applied to an open document's live text
 *   false                 the document changed since (conflict `doc-changed`)
 *   { ok: false }         not applied, with the reason
 *   null                  the change is not for an open document: it goes
 *                         to the workspace file
 */
export type DocumentApplyResult =
  | boolean
  | null
  | { ok: true; to?: "document" | "tab"; asSuggestion?: boolean; undoable?: boolean }
  | { ok: false; conflict: StagedConflict; error?: string };
export type DocumentApplier = (change: StagedChange) => DocumentApplyResult | Promise<DocumentApplyResult>;
let documentApplier: DocumentApplier | null = null;

/**
 * A cheap fingerprint of a whole text (length + FNV-1a over UTF-16 code
 * units). Range proposals carry the fingerprint of the text they were
 * computed on (`basis`), so approval can tell whether that text — or that
 * text with recorded approvals applied — is exactly what is there now.
 */
export function textFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length.toString(36)}.${(h >>> 0).toString(36)}`;
}

function emit(): void {
  for (const l of [...listeners]) l(changes);
}

function update(id: string, patch: Partial<StagedChange>): StagedChange | undefined {
  let found: StagedChange | undefined;
  changes = changes.map((c) => {
    if (c.id !== id) return c;
    found = { ...c, ...patch } as StagedChange;
    return found;
  });
  emit();
  return found;
}

export function stageChange(proposal: ChangeProposal, meta: { tool: string; runId?: string; agentId?: string }): StagedChange {
  const change = { ...proposal, ...meta, id: `chg_${Date.now().toString(36)}_${(++seq).toString(36)}`, createdAt: Date.now(), status: "pending" } as StagedChange;
  // Settled changes go first when the cap is reached. A pending one is never dropped:
  // when every entry is pending, the new proposal is refused instead.
  const next = [...changes, change];
  while (next.length > MAX_CHANGES) {
    const i = next.findIndex((c) => c.status !== "pending");
    if (i < 0) throw new Error(`${MAX_CHANGES} proposed changes are waiting for review: approve or reject some before an agent proposes more`);
    next.splice(i, 1);
  }
  changes = next;
  emit();
  return change;
}

export function receiptOf(change: StagedChange): StagedReceipt {
  return { staged: true, changeId: change.id, kind: change.kind, path: change.path, summary: change.summary };
}

export function isStagedReceipt(v: unknown): v is StagedReceipt {
  return !!v && typeof v === "object" && (v as StagedReceipt).staged === true && typeof (v as StagedReceipt).changeId === "string";
}

export function getStagedChange(id: string): StagedChange | undefined {
  return changes.find((c) => c.id === id);
}

/** Oldest first; `pending` only by default. */
export function listStagedChanges(opts: { all?: boolean; runId?: string } = {}): StagedChange[] {
  return changes.filter((c) => (opts.all || c.status === "pending") && (!opts.runId || c.runId === opts.runId));
}

export function onStagedChanges(listener: (list: readonly StagedChange[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The editor registers how a document change reaches the live buffer (null to unregister). */
export function setDocumentApplier(fn: DocumentApplier | null): void {
  documentApplier = fn;
}

const CONTEXT = 40;

/** The text around [from, to) when a change is proposed; `atStart` / `atEnd` when it reaches the document's edge. */
export function rangeContext(doc: string, from: number, to: number): RangeContext {
  const start = Math.max(0, from - CONTEXT);
  const end = Math.min(doc.length, to + CONTEXT);
  return { before: doc.slice(start, from), after: doc.slice(to, end), atStart: start === 0, atEnd: end === doc.length };
}

/** One approved edit: the text with a given fingerprint became `next` by replacing [from, to) with `length` characters. */
interface Step {
  next: string;
  from: number;
  to: number;
  length: number;
}
const MAX_STEPS = 500;
const steps = new Map<string, Step>();

/** [from, to) after an edit replaced [edit.from, edit.to) with `edit.length` characters; null when they overlap. */
export function mapRange(from: number, to: number, edit: { from: number; to: number; length: number }): { from: number; to: number } | null {
  if (to <= edit.from) return { from, to };
  if (from >= edit.to) {
    const d = edit.length - (edit.to - edit.from);
    return { from: from + d, to: to + d };
  }
  return null;
}

/**
 * Record that an approved change turned `prev` into `next` (replacing
 * [from, to) with `insert`), so other changes computed on `prev` — or on a
 * text that led to it — keep exact offsets (`locateRange`).
 */
export function recordEdit(prev: string, next: string, edit: { from: number; to: number; insert: string }): void {
  steps.set(textFingerprint(prev), { next: textFingerprint(next), from: edit.from, to: edit.to, length: edit.insert.length });
  if (steps.size > MAX_STEPS) steps.delete(steps.keys().next().value!);
}

/**
 * Where a range change goes in `text`:
 *  1. when `text` is the text the change was computed on (`basis`), or that
 *     text with only recorded approvals applied since: at its offsets,
 *     mapped through those approvals ("overlap" when it overlaps one);
 *  2. otherwise at its offsets when they still hold `before` (and its
 *     surroundings, when known), else at the single place where
 *     surroundings + `before` occur. Null when neither — an insertion
 *     (empty `before`) without surroundings cannot be located safely.
 */
export function locateRange(
  text: string,
  change: { from: number; to: number; before: string; context?: RangeContext; basis?: string },
): { from: number; to: number } | "overlap" | null {
  if (change.basis) {
    const now = textFingerprint(text);
    let { from, to } = change;
    let at = change.basis;
    const seen = new Set<string>();
    for (let step = steps.get(at); step && at !== now && !seen.has(at); step = steps.get(at)) {
      seen.add(at);
      const mapped = mapRange(from, to, step);
      if (!mapped) return "overlap";
      ({ from, to } = mapped);
      at = step.next;
    }
    if (at === now && text.slice(from, to) === change.before) return { from, to };
  }
  const ctx = change.context;
  const fits = (at: number) => {
    const end = at + change.before.length;
    if (text.slice(at, end) !== change.before) return false;
    if (!ctx) return true;
    const pre = text.slice(Math.max(0, at - ctx.before.length), at);
    const post = text.slice(end, end + ctx.after.length);
    if (pre !== ctx.before || post !== ctx.after) return false;
    // A range proposed at the very start (or end) must still be there: new frontmatter goes at 0, not after other text.
    if (ctx.atStart && !ctx.before && at !== 0) return false;
    if (ctx.atEnd && !ctx.after && end !== text.length) return false;
    return true;
  };
  const span = (at: number) => ({ from: at, to: at + change.before.length });
  if ((ctx || change.before) && fits(change.from)) return span(change.from);
  const needle = (ctx?.before ?? "") + change.before + (ctx?.after ?? "");
  if (!needle) return null;
  const hit = text.indexOf(needle);
  if (hit < 0 || text.indexOf(needle, hit + 1) >= 0) return null;
  const at = hit + (ctx?.before.length ?? 0);
  return fits(at) ? span(at) : null;
}

/** `text` with the range change applied (see `locateRange`), or null when it cannot be placed. */
export function applyRangeToText(text: string, change: { from: number; to: number; before: string; after: string; context?: RangeContext; basis?: string }): string | null {
  const at = locateRange(text, change);
  return at && at !== "overlap" ? text.slice(0, at.from) + change.after + text.slice(at.to) : null;
}

async function workspace() {
  return import("../storage/workspace");
}

const CONFLICT_TEXT: Record<StagedConflict, string> = {
  "file-changed": "the file changed since the change was proposed",
  "file-created": "the file was created since",
  "doc-changed": "the document changed since the change was proposed",
  overlap: "it overlaps a change approved before it",
  "open-unsaved": "the file is open with edits the change was not computed from",
  "not-open": "the document it was proposed for is no longer open",
  failed: "it could not be applied",
};

/**
 * Approve a pending change: this is the only path from an agent's
 * proposal to a write. Resolves to the change with its new status
 * (`applied`, or `conflict` with the reason).
 */
export async function approveStagedChange(id: string): Promise<StagedChange> {
  const change = getStagedChange(id);
  if (!change) throw new Error(`No staged change ${id}`);
  if (change.status !== "pending") throw new Error(`Change ${id} is already ${change.status}`);
  const conflict = (code: StagedConflict, error = CONFLICT_TEXT[code]) => update(id, { status: "conflict", conflict: code, error })!;
  try {
    // An open document first: its live text is what the user sees and saves.
    const res = documentApplier ? await documentApplier(change) : null;
    if (res === true) return update(id, { status: "applied", appliedTo: "document" })!;
    if (res === false) return conflict("doc-changed");
    if (res && res.ok) {
      const patch: Partial<StagedChange> = { status: "applied", appliedTo: res.to ?? "document" };
      if (res.asSuggestion) patch.asSuggestion = true;
      if (res.undoable === false) patch.noUndo = true;
      return update(id, patch)!;
    }
    if (res) return conflict(res.conflict, res.error ?? CONFLICT_TEXT[res.conflict]);
    if (change.kind === "file") {
      const ws = await workspace();
      const exists = await ws.workspaceHasFile(change.path);
      const current = exists ? await ws.readWorkspaceFile(change.path) : null;
      if (current !== change.before) return conflict(change.before === null ? "file-created" : "file-changed");
      await ws.writeWorkspaceFile(change.path, change.after);
      return update(id, { status: "applied", appliedTo: "file" })!;
    }
    if (!change.path) return conflict("not-open", documentApplier ? CONFLICT_TEXT["not-open"] : "no editor is open to apply the change to");
    const ws = await workspace();
    if (!(await ws.workspaceHasFile(change.path))) return conflict("file-changed", "the file no longer exists");
    const current = await ws.readWorkspaceFile(change.path);
    const at = locateRange(current, change);
    if (at === "overlap") return conflict("overlap");
    if (!at) return conflict("doc-changed");
    const next = current.slice(0, at.from) + change.after + current.slice(at.to);
    await ws.writeWorkspaceFile(change.path, next);
    recordEdit(current, next, { from: at.from, to: at.to, insert: change.after });
    return update(id, { status: "applied", appliedTo: "file" })!;
  } catch (e) {
    return conflict("failed", (e as Error)?.message ?? String(e));
  }
}

export function rejectStagedChange(id: string): StagedChange | undefined {
  const change = getStagedChange(id);
  if (!change || change.status !== "pending") return change;
  return update(id, { status: "rejected" });
}

/** Withdraw a run's pending proposals (the run was cancelled). */
export function discardRunChanges(runId: string): number {
  let n = 0;
  changes = changes.map((c) => {
    if (c.runId !== runId || c.status !== "pending") return c;
    n++;
    return { ...c, status: "rejected", error: "the run was cancelled", withdrawn: true } as StagedChange;
  });
  if (n) emit();
  return n;
}

/** Tests. */
export function clearStagedChanges(): void {
  changes = [];
  steps.clear();
  documentApplier = null;
  emit();
}
