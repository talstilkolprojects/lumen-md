/**
 * The learning critic (T30): what actually worked on this machine.
 *
 * When the user picks a suggestion in the panel, the choice is remembered
 * (agent, diagnosis, suggestion). When the re-run of that agent on the
 * same input finishes, the outcome is recorded — in IndexedDB, on this
 * device only. Next time the critic reaches the same diagnosis, the
 * suggestions that worked here come first; ones that kept failing sink.
 */
import { createStore, get, set, type UseStore } from "idb-keyval";
import type { AgentRun, Suggestion } from "./types";

interface Tally {
  ok: number;
  fail: number;
  last: number;
}

/** key: `${diagnosis}\u0000${suggestionId}` (and an agent-specific twin). */
type Book = Record<string, Tally>;

const PENDING_TTL_MS = 10 * 60_000;
const KEY = "outcomes.v1";

let db: UseStore | null = null;
let book: Book | null = null;
let loading: Promise<Book> | null = null;
const pending = new Map<string, { suggestionId: string; diagnosis: string; at: number }>();

function store(): UseStore | null {
  if (typeof indexedDB === "undefined") return null;
  return (db ??= createStore("lumen-agent-outcomes", "kv"));
}

export function loadOutcomes(): Promise<Book> {
  if (book) return Promise.resolve(book);
  return (loading ??= (async () => {
    const s = store();
    try {
      book = (s ? ((await get(KEY, s)) as Book | undefined) : undefined) ?? {};
    } catch {
      book = {};
    }
    return book;
  })());
}

async function save(): Promise<void> {
  const s = store();
  if (!s || !book) return;
  try {
    await set(KEY, book, s);
  } catch {
    /* why: storage denied: learning stays in memory for the session */
  }
}

const pendingKey = (agentId: string, inputKey?: string) => `${agentId}\u0000${inputKey ?? ""}`;

/** The diagnosis of a failed run: the label of its last critic step. */
export function diagnosisOf(run: AgentRun): string {
  const steps = run.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].kind === "critic" && steps[i].label) return steps[i].label!;
  return run.errorCode ?? "error";
}

/** The user picked `s` for the failed `run`. */
export function noteSuggestionChosen(s: Suggestion, run: AgentRun): void {
  pending.set(pendingKey(run.agentId, run.inputKey), { suggestionId: s.id, diagnosis: diagnosisOf(run), at: Date.now() });
}

/** Called for every finished run: closes a pending choice with its outcome. */
export async function noteRunOutcome(run: AgentRun): Promise<void> {
  const k = pendingKey(run.agentId, run.inputKey);
  const p = pending.get(k);
  if (!p) return;
  pending.delete(k);
  if (Date.now() - p.at > PENDING_TTL_MS || run.status === "aborted") return;
  const ok = run.status === "ok";
  const b = await loadOutcomes();
  for (const key of [`${p.diagnosis}\u0000${p.suggestionId}`, `${run.agentId}\u0000${p.diagnosis}\u0000${p.suggestionId}`]) {
    const t = (b[key] ??= { ok: 0, fail: 0, last: 0 });
    if (ok) t.ok++;
    else t.fail++;
    t.last = Date.now();
  }
  await save();
}

/** Smoothed success rate; 0.5 = no evidence. Agent-specific evidence wins. */
export function successRate(b: Book, diagnosis: string, suggestionId: string, agentId?: string): number {
  const t = (agentId && b[`${agentId}\u0000${diagnosis}\u0000${suggestionId}`]) || b[`${diagnosis}\u0000${suggestionId}`];
  if (!t) return 0.5;
  return (t.ok + 1) / (t.ok + t.fail + 2);
}

/** Order suggestions by what worked here; the critic's order breaks ties. */
export async function rankByOutcomes(suggestions: Suggestion[], diagnosis: string, agentId?: string): Promise<Suggestion[]> {
  if (suggestions.length < 2) return suggestions;
  const b = await loadOutcomes();
  return suggestions
    .map((s, i) => ({ s, i, r: successRate(b, diagnosis, s.id, agentId) }))
    .sort((x, y) => y.r - x.r || x.i - y.i)
    .map((x) => x.s);
}

/** Test hook. */
export function __resetOutcomes(): void {
  book = null;
  loading = null;
  db = null;
  pending.clear();
}
