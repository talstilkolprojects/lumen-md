/**
 * An organizer run (plan W2.1): read the vault, analyse it, and hand the
 * suggestions to the review screen (plan 5.11) a batch at a time — with
 * Pause / Resume / Cancel and progress like the batch jobs (plan 5.8).
 *
 * Nothing is written here. Each suggestion's changes are staged
 * (`staging.stageChange`) under the agent id `organizer` and one run id per
 * suggestion; the user approves or rejects them in the review panel, and
 * each decision is learned (learning.ts). Link and tag edits are staged as
 * range changes on the note's file, so several in one note can be approved
 * in any order; merges and new maps of content are whole-file changes.
 *
 * An optional model seam (`setOrganizerModel`) can re-score each
 * suggestion with a local model; without one the analysis is
 * deterministic (analyze.ts).
 */
import { onStagedChanges, rangeContext, stageChange, textFingerprint } from "../staging";
import type { StagedChange } from "../types";
import { t } from "../../i18n";
import { analyzeVault, type AnalyzeOptions, type OrganizerNote, type OrganizerSuggestion } from "./analyze";
import { applyLearning, loadBook, recordDecision } from "./learning";

export const ORGANIZER_AGENT = "organizer";
export const DEFAULT_BATCH = 20;

/** Re-scores a suggestion with a model (null: keep it as it is; confidence 0: drop it). */
export type OrganizerModel = (s: OrganizerSuggestion, notes: ReadonlyMap<string, string>, signal: AbortSignal) => Promise<{ confidence: number } | null>;
let model: OrganizerModel | null = null;
/** Plug in a model judge (plan W2.1 seam; e.g. the local Ollama model through the agent runtime). */
export function setOrganizerModel(fn: OrganizerModel | null): void {
  model = fn;
}

export type OrganizerPhase = "reading" | "analysing" | "ready" | "cancelled" | "failed";

export interface OrganizerState {
  phase: OrganizerPhase;
  paused: boolean;
  read: number;
  total: number;
  suggestions: OrganizerSuggestion[];
  /** How many suggestions have been sent to the review screen. */
  staged: number;
  counts: Record<OrganizerSuggestion["kind"], number>;
  startedAt: number;
  /** ms per note while reading, for an ETA. */
  msPerNote: number | null;
  error?: string;
}

export interface OrganizerSource {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
}

export interface OrganizerJob {
  readonly state: OrganizerState;
  subscribe(fn: (s: OrganizerState) => void): () => void;
  pause(): void;
  resume(): void;
  cancel(): void;
  /** Stage the next `n` suggestions for review; resolves to how many were staged. */
  stageNext(n?: number): number;
  /** Stop learning from this run's decisions (the panel closed and nothing of it is pending). */
  dispose(): void;
  /** Resolves when reading and analysis are done (or cancelled). */
  done: Promise<OrganizerState>;
}

/** The app's workspace as a source: every Markdown note. */
export async function workspaceSource(): Promise<OrganizerSource> {
  const ws = await import("../../storage/workspace");
  return {
    list: async () => (await ws.listWorkspace()).map((e) => e.path).filter((p) => /\.(md|markdown)$/i.test(p)),
    read: (p) => ws.readWorkspaceFile(p),
  };
}

const summaryOf = (s: OrganizerSuggestion) => `${Math.round(s.confidence * 100)}% · ${t(s.reason.key, s.reason.params)}`;

export function startOrganizer(source: OrganizerSource, opts: AnalyzeOptions & { chunk?: number } = {}): OrganizerJob {
  const listeners = new Set<(s: OrganizerState) => void>();
  const abort = new AbortController();
  let state: OrganizerState = { phase: "reading", paused: false, read: 0, total: 0, suggestions: [], staged: 0, counts: { link: 0, tag: 0, merge: 0, moc: 0 }, startedAt: Date.now(), msPerNote: null };
  let wake: (() => void) | null = null;
  const emit = (patch: Partial<OrganizerState>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
  };
  /** run id → the suggestion it stages, and how many of its changes are still undecided. */
  const runs = new Map<string, { s: OrganizerSuggestion; open: Set<string>; approved: boolean }>();
  const offStaged = onStagedChanges((list) => {
    for (const c of list) settle(c);
  });
  const settle = (c: StagedChange) => {
    if (c.agentId !== ORGANIZER_AGENT || !c.runId || c.status === "pending") return;
    const r = runs.get(c.runId);
    if (!r || !r.open.has(c.id)) return;
    r.open.delete(c.id);
    if (c.status !== "applied") r.approved = false;
    // A suggestion is approved when all of its changes are; one rejection rejects it.
    if (r.open.size === 0 || c.status === "rejected") {
      runs.delete(c.runId);
      // A conflict says nothing about the suggestion's quality.
      if (c.status !== "conflict") void recordDecision(r.s.features, r.approved && c.status === "applied");
    }
  };

  const waitIfPaused = async () => {
    while (state.paused && !abort.signal.aborted) await new Promise<void>((res) => (wake = res));
  };

  const done = (async (): Promise<OrganizerState> => {
    try {
      const paths = await source.list();
      emit({ total: paths.length });
      const notes: OrganizerNote[] = [];
      const chunk = opts.chunk ?? 50;
      const t0 = Date.now();
      for (let i = 0; i < paths.length; i += chunk) {
        await waitIfPaused();
        if (abort.signal.aborted) return (emit({ phase: "cancelled" }), state);
        for (const p of paths.slice(i, i + chunk)) {
          try {
            notes.push({ path: p, text: await source.read(p) });
          } catch {
            /* unreadable: skipped */
          }
        }
        emit({ read: Math.min(paths.length, i + chunk), msPerNote: (Date.now() - t0) / Math.max(1, Math.min(paths.length, i + chunk)) });
        // Let the UI breathe between chunks.
        await new Promise((r) => setTimeout(r, 0));
      }
      emit({ phase: "analysing" });
      await waitIfPaused();
      if (abort.signal.aborted) return (emit({ phase: "cancelled" }), state);
      let list = applyLearning(analyzeVault(notes, opts), await loadBook(), opts.minConfidence ?? 0.5);
      if (model) {
        const texts = new Map(notes.map((n) => [n.path, n.text]));
        const scored: OrganizerSuggestion[] = [];
        for (const s of list) {
          await waitIfPaused();
          if (abort.signal.aborted) return (emit({ phase: "cancelled" }), state);
          const r = await model(s, texts, abort.signal).catch(() => null);
          if (!r) scored.push(s);
          else if (r.confidence >= (opts.minConfidence ?? 0.5)) scored.push({ ...s, confidence: r.confidence });
        }
        list = scored.sort((x, y) => y.confidence - x.confidence);
      }
      const counts = { link: 0, tag: 0, merge: 0, moc: 0 };
      for (const s of list) counts[s.kind]++;
      emit({ phase: "ready", suggestions: list, counts });
      return state;
    } catch (e) {
      emit({ phase: "failed", error: (e as Error)?.message ?? String(e) });
      return state;
    }
  })();

  const stageOne = (s: OrganizerSuggestion) => {
    const runId = `organizer-${s.id}`;
    const open = new Set<string>();
    for (const c of s.changes) {
      const summary = summaryOf(s);
      const staged =
        c.range && c.before !== null
          ? stageChange({ kind: "range", path: c.path, from: c.range.from, to: c.range.to, before: c.range.before, after: c.range.after, context: rangeContext(c.before, c.range.from, c.range.to), basis: textFingerprint(c.before), summary }, { tool: `organize_${s.kind}`, runId, agentId: ORGANIZER_AGENT })
          : stageChange({ kind: "file", path: c.path, before: c.before, after: c.after, summary }, { tool: `organize_${s.kind}`, runId, agentId: ORGANIZER_AGENT });
      open.add(staged.id);
    }
    runs.set(runId, { s, open, approved: true });
  };

  return {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    pause() {
      if (state.phase === "reading" || state.phase === "analysing") emit({ paused: true });
    },
    resume() {
      emit({ paused: false });
      wake?.();
      wake = null;
    },
    cancel() {
      abort.abort();
      emit({ paused: false });
      wake?.();
      wake = null;
    },
    dispose() {
      offStaged();
    },
    stageNext(n = DEFAULT_BATCH) {
      if (state.phase !== "ready") return 0;
      const next = state.suggestions.slice(state.staged, state.staged + n);
      for (const s of next) stageOne(s);
      emit({ staged: state.staged + next.length });
      return next.length;
    },
    done,
  };
}
