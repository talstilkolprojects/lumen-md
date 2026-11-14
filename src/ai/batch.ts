/**
 * Batch AI over a folder (Plan D: D9): tag, summarise or translate many
 * notes through the providers' batch APIs — Anthropic Message Batches or
 * the OpenAI Batch API — which bill at half price and answer within 24 h.
 *
 * A job is submitted once, remembered in localStorage, polled with "AI:
 * Check Batch Jobs", and its results are applied to the notes when they
 * arrive (never to a note that is open in a tab, and only after the user
 * confirms).
 */
import { getActiveProvider, getProviderKey, effectiveModel, AiError, type AiProvider } from "./llm";
import { aiOperation, isAbort } from "./aiAbort";
import { assertCloudAllowed, getAiPolicy } from "./policy";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { PROMPTS } from "./prompts";
import { recordUsage } from "./usage";
import { log } from "../lib/logger";
import { frontmatterField, textHash, TRANSLATED_FROM, TRANSLATION_JOB } from "./batchWrites";
import type { BatchJob, BatchProvider, BatchOp, BatchItem } from "./batchWrites";
export { planWrites, setFrontmatterField, parseTags, stripYamlComment, frontmatterField, frontmatterTags, mergeTags, textHash, TRANSLATED_FROM, TRANSLATION_JOB } from "./batchWrites";
export type { PlannedWrite, BatchJob, BatchProvider, BatchOp, BatchItem } from "./batchWrites";

const TRANSLATIONS = "lumen.ai.batch.translations";
/**
 * Paths of translation files older batches recorded (before translations
 * carried a `translatedFrom` marker; see isBatchTranslation). Read-only.
 */
export function knownTranslations(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(TRANSLATIONS) ?? "[]");
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

/** True for a note a translation batch generated (so later batches skip it). */
export function isBatchTranslation(content: string): boolean {
  // Both markers: a user's own `translatedFrom` field alone isn't ours.
  return frontmatterField(content, TRANSLATED_FROM) !== null && frontmatterField(content, TRANSLATION_JOB) !== null;
}

const STORE = "lumen.ai.batches";
/** Characters of each note sent (long notes are cut, with a marker). */
export const MAX_NOTE_CHARS = 24_000;

/**
 * Where a batch runs: the provider's half-price Batch API only under the
 * `cloud` policy with OpenAI / Anthropic selected; otherwise the local
 * queue on this device.
 */
export function batchProviderFor(provider: AiProvider): BatchProvider | null {
  if (getAiPolicy() === "cloud") return provider === "anthropic" || provider === "openai" ? provider : null;
  return "local";
}

export function loadJobs(): BatchJob[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Persist the job list; false when storage is full or blocked. */
export function saveJobs(jobs: BatchJob[]): boolean {
  try {
    // Unfinished jobs are always kept; only finished history is trimmed.
    const finished = jobs.filter((j) => j.status === "applied" || j.status === "failed" || j.status === "expired" || j.status === "cancelled");
    const keep = new Set([...jobs.filter((j) => !finished.includes(j)), ...finished.slice(-50)]);
    localStorage.setItem(STORE, JSON.stringify(jobs.filter((j) => keep.has(j))));
    return true;
  } catch {
    return false;
  }
}

const TAG_SYSTEM =
  "Suggest 3-7 concise lowercase-kebab-case tags that capture this Markdown note's topic. " +
  'Output ONLY a JSON array of strings, e.g. ["machine-learning","paper-summary"].';
const SUMMARY_SYSTEM = "Summarise this Markdown note in one or two plain sentences (no Markdown, no preamble). Use the note's language.";

/** System prompt and user message for one note. */
export function requestFor(op: BatchOp, text: string, lang?: string): { system: string; user: string; maxTokens: number } {
  const body = text.length > MAX_NOTE_CHARS ? text.slice(0, MAX_NOTE_CHARS) + "\n…" : text;
  if (op === "tags") return { system: TAG_SYSTEM, user: body, maxTokens: 100 };
  if (op === "summary") return { system: SUMMARY_SYSTEM, user: body, maxTokens: 200 };
  return { system: PROMPTS.translate, user: `Target language: ${lang ?? "English"}\n\n---\n\n${body}`, maxTokens: Math.min(16_000, Math.ceil(body.length / 2) + 500) };
}

type Fetch = typeof fetch;

/* ─── Anthropic Message Batches ─────────────────────────────────────── */

const ANTHROPIC = "https://api.anthropic.com/v1/messages/batches";
const anthropicHeaders = () => ({
  "Content-Type": "application/json",
  "x-api-key": getProviderKey("anthropic"),
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
});

/* ─── OpenAI Batch API ──────────────────────────────────────────────── */

const OPENAI = "https://api.openai.com/v1";

/** Submit a job for `notes`; returns the stored job. */
export async function submitBatch(
  op: BatchOp,
  notes: ReadonlyArray<{ path: string; text: string }>,
  opts: { lang?: string; fetchImpl?: Fetch } = {},
): Promise<BatchJob> {
  const f = opts.fetchImpl ?? fetch;
  const provider = batchProviderFor(getActiveProvider());
  if (!provider) throw new AiError("API_ERROR", "Batch jobs need the OpenAI or Anthropic provider (AI: Switch Provider).");
  if (provider === "local") return submitLocalBatch(op, notes, opts.lang);
  assertCloudAllowed(`${provider} batch API`);
  const model = effectiveModel(provider);
  const items: BatchItem[] = notes.map((n, i) => ({ customId: `n${i}`, path: n.path, hash: textHash(n.text) }));
  let id: string;
  if (provider === "anthropic") {
    const requests = notes.map((n, i) => {
      const r = requestFor(op, n.text, opts.lang);
      return { custom_id: items[i].customId, params: { model, max_tokens: r.maxTokens, system: r.system, messages: [{ role: "user", content: r.user }] } };
    });
    const res = await f(ANTHROPIC, { method: "POST", headers: anthropicHeaders(), body: JSON.stringify({ requests }) });
    if (!res.ok) throw new AiError("API_ERROR", `Anthropic batch ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    id = (await res.json()).id;
  } else {
    const key = getProviderKey("openai");
    const jsonl = notes
      .map((n, i) => {
        const r = requestFor(op, n.text, opts.lang);
        return JSON.stringify({
          custom_id: items[i].customId,
          method: "POST",
          url: "/v1/chat/completions",
          body: { model, max_tokens: r.maxTokens, messages: [{ role: "system", content: r.system }, { role: "user", content: r.user }] },
        });
      })
      .join("\n");
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "lumen-batch.jsonl");
    const up = await f(`${OPENAI}/files`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    if (!up.ok) throw new AiError("API_ERROR", `OpenAI file upload ${up.status}`);
    const fileId = (await up.json()).id;
    const res = await f(`${OPENAI}/batches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input_file_id: fileId, endpoint: "/v1/chat/completions", completion_window: "24h" }),
    });
    if (!res.ok) throw new AiError("API_ERROR", `OpenAI batch ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    id = (await res.json()).id;
  }
  const job: BatchJob = { id, provider, model, op, lang: opts.lang, createdAt: new Date().toISOString(), items, status: "submitted" };
  if (!saveJobs([...loadJobs(), job])) {
    // The provider already has the job: give its ID so the results stay reachable.
    throw new AiError(
      "API_ERROR",
      `Batch ${id} was submitted to ${provider}, but this device couldn't save it (storage full or blocked), so "Check Batch Jobs" won't list it. Its results are in your ${provider} console under that ID.`,
    );
  }
  return job;
}

export interface BatchResults {
  /** "processing" while the provider is still working. */
  state: "processing" | "ended" | "failed" | "expired" | "cancelled";
  /** customId → answer text (succeeded requests only). */
  answers: Map<string, string>;
  failed: number;
}

/** Poll a job; when it has ended, download its results and meter them (batch price). */
export async function fetchBatchResults(job: BatchJob, fetchImpl: Fetch = fetch): Promise<BatchResults> {
  if (job.provider === "local") return localBatchResults(job);
  assertCloudAllowed(`${job.provider} batch API`);
  const answers = new Map<string, string>();
  let failed = 0;
  // Results may be fetched again (user declined to apply): meter once.
  const alreadyMetered = !!job.metered;
  const meter = (model: string, usage: { input: number; output: number }) => {
    if (!alreadyMetered) recordUsage({ provider: job.provider, model, inputTokens: usage.input, outputTokens: usage.output, batch: true });
    job.metered = true;
  };
  if (job.provider === "anthropic") {
    const res = await fetchImpl(`${ANTHROPIC}/${job.id}`, { headers: anthropicHeaders() });
    if (!res.ok) throw new AiError("API_ERROR", `Anthropic batch ${res.status}`);
    const b = await res.json();
    if (b.processing_status !== "ended") return { state: "processing", answers, failed };
    const out = await fetchImpl(b.results_url, { headers: anthropicHeaders() });
    if (!out.ok) throw new AiError("API_ERROR", `Anthropic batch results ${out.status}`);
    for (const line of (await out.text()).split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.result?.type === "succeeded") {
        const m = r.result.message;
        const text = (m.content ?? []).filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("").trim();
        if (text) answers.set(r.custom_id, text);
        if (m.usage) meter(m.model ?? job.model, { input: m.usage.input_tokens ?? 0, output: m.usage.output_tokens ?? 0 });
      } else failed++;
    }
    return { state: "ended", answers, failed };
  }
  const key = getProviderKey("openai");
  const res = await fetchImpl(`${OPENAI}/batches/${job.id}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new AiError("API_ERROR", `OpenAI batch ${res.status}`);
  const b = await res.json();
  if (b.status === "failed" || b.status === "expired" || b.status === "cancelled") return { state: b.status, answers, failed: job.items.length };
  if (b.status !== "completed") return { state: "processing", answers, failed };
  // Failed requests go to error_file_id; request_counts has the total.
  const reportedFailed = Number(b.request_counts?.failed ?? 0);
  if (!b.output_file_id) return { state: "ended", answers, failed: Math.max(reportedFailed, job.items.length) };
  {
    const out = await fetchImpl(`${OPENAI}/files/${b.output_file_id}/content`, { headers: { Authorization: `Bearer ${key}` } });
    if (!out.ok) throw new AiError("API_ERROR", `OpenAI batch results ${out.status}`);
    for (const line of (await out.text()).split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      const body = r.response?.body;
      const text = body?.choices?.[0]?.message?.content?.trim();
      if (r.response?.status_code === 200 && text) {
        answers.set(r.custom_id, text);
        if (body.usage) meter(body.model ?? job.model, { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 });
      } else failed++;
    }
  }
  return { state: "ended", answers, failed: Math.max(failed + reportedFailed, job.items.length - answers.size) };
}

/* ─── Local queue ───────────────────────────────────────────────────── */

/**
 * The local queue: each note goes to a native local executor — Ollama,
 * else the in-browser model — one at a time in the background, and never
 * to a cloud provider whatever the policy says (the job is labelled and
 * priced as running on this device), with the
 * same prompts as the cloud Batch API, so "Check Batch Jobs" and
 * planWrites() apply the answers unchanged. Answers are kept in
 * IndexedDB (`lumen-batch-local:<id>`), so a run interrupted by closing
 * the tab resumes on the next check from the notes that are still
 * missing (re-read from the workspace; edited notes are skipped by
 * planWrites' hash check as usual).
 */
interface LocalState {
  answers: Record<string, string>;
  failed: string[];
  finished: boolean;
  /** No local model was available: the run paused and resumes on the next check. */
  blocked?: boolean;
  /** Paused by the user (plan 5.8): nothing runs until Resume — kept across a reload. */
  paused?: boolean;
  /** Cancelled by the user: the run stops and nothing is applied. */
  cancelled?: boolean;
  /** How long the last finished notes took (ms), for the ETA. */
  durations?: number[];
  /** customId → why the job's validator (after the critic's retry) rejected the answer. */
  rejected?: Record<string, string>;
}

const LOCAL_KEY = (id: string) => `lumen-batch-local:${id}`;
const running = new Map<string, Promise<void>>();
/** The note in flight per job: Pause and Cancel abort it, so it isn't counted as failed. */
const inFlight = new Map<string, AbortController>();
/** Durations kept for the ETA. */
const ETA_WINDOW = 20;
const listeners = new Set<() => void>();

/** Live updates for the batch panel: called after every note and every pause / resume / cancel. */
export function subscribeBatch(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emitBatch(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      log.warn("batch listener failed", e);
    }
  }
}
/**
 * The latest state of each job this session, so a job whose IndexedDB
 * write failed (storage blocked or full) can still be applied now instead
 * of re-running from scratch on every check.
 */
const memory = new Map<string, LocalState>();
const unsaved = new Set<string>();

async function loadLocal(id: string): Promise<LocalState> {
  const mem = memory.get(id);
  if (mem) return mem;
  const v = (await idbGet(LOCAL_KEY(id)).catch(() => undefined)) as LocalState | undefined;
  // One object per job this session, so a pause seen by the panel is the one the run checks.
  const raced = memory.get(id);
  if (raced) return raced;
  const state = v ?? { answers: {}, failed: [], finished: false };
  memory.set(id, state);
  return state;
}

async function saveLocal(id: string, state: LocalState): Promise<void> {
  memory.set(id, state);
  // Listeners hear the change as soon as it is visible (progress reads this memory), not after the disk write.
  emitBatch();
  try {
    await idbSet(LOCAL_KEY(id), state);
    unsaved.delete(id);
  } catch {
    unsaved.add(id);
  }
}

/** Thrown when neither Ollama nor the in-browser model can run the job. */
export class NoLocalModelError extends Error {
  constructor() {
    super("No local model is available on this device — start Ollama (or open Lumen in a WebGPU browser), then check the batch again.");
    this.name = "NoLocalModelError";
  }
}

/** The local executor and model a batch would use now, or null when none is available. */
export async function localBatchRoute(): Promise<{ executor: "ollama" | "webllm"; model: string } | null> {
  const { pickExecutor } = await import("../agents/executors");
  for (const id of ["ollama", "webllm"] as const) {
    // Forced picks: local executors only, whatever the policy.
    const { executor } = await pickExecutor([id], id);
    if (executor) return { executor: id, model: executor.modelFor("small") };
  }
  return null;
}

/** What a local answer is checked against (plan 5.8): the job's operation and the note as sent. */
export interface LocalAnswerContext {
  op?: BatchOp;
  source?: string;
  signal?: AbortSignal;
}

/** Injected in tests; defaults to a native local executor, quota already paid at submit. */
let localAnswer: (system: string, user: string, maxTokens: number, ctx?: LocalAnswerContext) => Promise<string> = async (system, user, maxTokens, ctx = {}) => {
  const route = await localBatchRoute();
  if (!route) throw new NoLocalModelError();
  // Plan 5.5: the `batch` agent, through the runtime, forced onto the local
  // executor and model the job runs on; the job was charged when submitted.
  // Plan 5.8: the agent validates the answer for the job's operation, and
  // its critic retries once with a hint.
  const [{ runAgentOrThrow }, { batchAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
  return runAgentOrThrow(
    batchAgent,
    { text: user, extra: { system, maxTokens, op: ctx.op, source: ctx.source } },
    { executor: route.executor, patch: { model: route.model }, prepaid: true, signal: ctx.signal },
  );
};
let readNote: (path: string) => Promise<string | null> = async (path) => {
  const { readWorkspaceFile } = await import("../storage/workspace");
  return readWorkspaceFile(path).catch(() => null);
};

let routeNow: typeof localBatchRoute = () => localBatchRoute();

export function __setLocalBatchDeps(deps: { answer?: typeof localAnswer; read?: typeof readNote; route?: typeof localBatchRoute }): void {
  if (deps.answer) localAnswer = deps.answer;
  if (deps.route) routeNow = deps.route;
  if (deps.read) readNote = deps.read;
}

const stopped = (s: LocalState) => !!s.paused || !!s.cancelled;

function runLocal(job: BatchJob, texts?: ReadonlyMap<string, string>): Promise<void> {
  const existing = running.get(job.id);
  if (existing) return existing;
  // Esc / "AI: Cancel" (T55) stops the note in flight; the job pauses and resumes on the next check.
  const op = aiOperation();
  const p = (async () => {
    const state = await loadLocal(job.id);
    if (stopped(state)) return;
    state.blocked = false;
    for (const item of job.items) {
      if (stopped(state)) return;
      if (op.signal.aborted) {
        await saveLocal(job.id, state); // not finished: the next check resumes it
        return;
      }
      if (item.customId in state.answers || state.failed.includes(item.customId)) continue;
      const text = texts?.get(item.path) ?? (await readNote(item.path));
      if (stopped(state)) return;
      if (text === null) {
        state.failed.push(item.customId);
      } else {
        const r = requestFor(job.op, text, job.lang);
        // One controller per note: Pause / Cancel (plan 5.8) and Esc / "AI: Cancel" (T55) both abort it.
        const ctrl = new AbortController();
        const onOpAbort = () => ctrl.abort();
        op.signal.addEventListener("abort", onOpAbort, { once: true });
        inFlight.set(job.id, ctrl);
        const started = Date.now();
        try {
          const answer = await localAnswer(r.system, r.user, r.maxTokens, { op: job.op, source: text.slice(0, MAX_NOTE_CHARS), signal: ctrl.signal });
          // Paused or cancelled while this note ran: it is not done, and not failed.
          if (stopped(state)) return;
          if (answer.trim()) state.answers[item.customId] = answer;
          else state.failed.push(item.customId);
          state.durations = [...(state.durations ?? []), Date.now() - started].slice(-ETA_WINDOW);
        } catch (e) {
          if (stopped(state)) return;
          if (op.signal.aborted || ctrl.signal.aborted || isAbort(e)) {
            // Cancelled by the user: this note is not failed — the next check resumes the job from it.
            await saveLocal(job.id, state);
            return;
          }
          if (e instanceof NoLocalModelError) {
            // Pause, don't fail the remaining notes: the next check resumes.
            state.blocked = true;
            await saveLocal(job.id, state);
            return;
          }
          state.failed.push(item.customId);
          state.rejected = { ...(state.rejected ?? {}), [item.customId]: ((e as Error)?.message ?? String(e)).slice(0, 200) };
          state.durations = [...(state.durations ?? []), Date.now() - started].slice(-ETA_WINDOW);
        } finally {
          op.signal.removeEventListener("abort", onOpAbort);
          if (inFlight.get(job.id) === ctrl) inFlight.delete(job.id);
        }
      }
      await saveLocal(job.id, state);
    }
    state.finished = true;
    await saveLocal(job.id, state);
  })().finally(() => {
    op.end();
    running.delete(job.id);
    emitBatch();
  });
  running.set(job.id, p);
  return p;
}

/* ─── Pause, resume, cancel, progress (plan 5.8) ─────────────────────── */

/**
 * Pause a local job: the note in flight is stopped (and runs again on
 * Resume), nothing else starts. Stored, so the job is still paused after a
 * reload.
 */
export async function pauseBatch(id: string): Promise<void> {
  const state = await loadLocal(id);
  if (state.finished || state.cancelled) return;
  state.paused = true;
  inFlight.get(id)?.abort();
  await saveLocal(id, state);
}

/** Resume a paused local job from the first note without an answer. */
export async function resumeBatch(job: BatchJob): Promise<void> {
  if (job.provider !== "local") return;
  const state = await loadLocal(job.id);
  if (state.finished || state.cancelled) return;
  state.paused = false;
  state.blocked = false;
  await saveLocal(job.id, state);
  // A paused run may still be settling: start after it has.
  await running.get(job.id);
  void runLocal(job);
}

/**
 * Cancel a job: a local run stops and its answers are dropped; a cloud job
 * is cancelled at the provider (policy-gated). The job is marked cancelled,
 * so nothing of it is ever applied.
 */
export async function cancelBatch(job: BatchJob, fetchImpl: Fetch = fetch): Promise<void> {
  if (job.provider === "local") {
    const state = await loadLocal(job.id);
    state.cancelled = true;
    state.paused = false;
    inFlight.get(job.id)?.abort();
    await saveLocal(job.id, state);
  } else {
    assertCloudAllowed(`${job.provider} batch API`);
    const res =
      job.provider === "anthropic"
        ? await fetchImpl(`${ANTHROPIC}/${job.id}/cancel`, { method: "POST", headers: anthropicHeaders() })
        : await fetchImpl(`${OPENAI}/batches/${job.id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${getProviderKey("openai")}` } });
    if (!res.ok) throw new AiError("API_ERROR", `${job.provider} batch cancel ${res.status}`);
  }
  const jobs = loadJobs();
  const stored = jobs.find((j) => j.id === job.id);
  if (stored) stored.status = "cancelled";
  job.status = "cancelled";
  saveJobs(jobs);
  emitBatch();
}

export interface BatchProgress {
  total: number;
  /** Notes with an answer. */
  done: number;
  failed: number;
  /** customId → why the answer was rejected. */
  rejected: Record<string, string>;
  paused: boolean;
  cancelled: boolean;
  /** No local model was available; Resume (or a check) tries again. */
  blocked: boolean;
  /** A note is being processed right now in this tab. */
  running: boolean;
  finished: boolean;
  /** Estimated time left, from the average of the last notes; null before the first. */
  etaMs: number | null;
}

/** Remaining time from recent per-note durations. Exported for tests. */
export function estimateEta(durations: readonly number[], remaining: number): number | null {
  if (!durations.length || remaining <= 0) return remaining <= 0 ? 0 : null;
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return Math.round(avg * remaining);
}

/** Where a local job stands. A cloud job reports only its total (the provider holds the rest). */
export async function batchProgress(job: BatchJob): Promise<BatchProgress> {
  const total = job.items.length;
  if (job.provider !== "local") {
    return { total, done: 0, failed: 0, rejected: {}, paused: false, cancelled: job.status === "cancelled", blocked: false, running: false, finished: job.status !== "submitted", etaMs: null };
  }
  const s = await loadLocal(job.id);
  const done = Object.keys(s.answers).length;
  const failed = s.failed.length;
  const paused = !!s.paused;
  return {
    total,
    done,
    failed,
    rejected: { ...(s.rejected ?? {}) },
    paused,
    cancelled: !!s.cancelled || job.status === "cancelled",
    blocked: !!s.blocked,
    running: running.has(job.id),
    finished: s.finished,
    etaMs: paused || s.cancelled ? null : estimateEta(s.durations ?? [], total - done - failed),
  };
}

async function submitLocalBatch(op: BatchOp, notes: ReadonlyArray<{ path: string; text: string }>, lang?: string): Promise<BatchJob> {
  const items: BatchItem[] = notes.map((n, i) => ({ customId: `n${i}`, path: n.path, hash: textHash(n.text) }));
  const id = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const route = await routeNow();
  if (!route) throw new NoLocalModelError();
  const job: BatchJob = { id, provider: "local", model: route.model, op, lang, createdAt: new Date().toISOString(), items, status: "submitted" };
  if (!saveJobs([...loadJobs(), job])) throw new AiError("API_ERROR", "This device couldn't save the batch job (storage full or blocked).");
  void runLocal(job, new Map(notes.map((n) => [n.path, n.text])));
  return job;
}

async function localBatchResults(job: BatchJob): Promise<BatchResults> {
  let state = await loadLocal(job.id);
  if (state.cancelled) return { state: "cancelled", answers: new Map(), failed: 0 };
  // Paused by the user: stays paused until Resume — a check doesn't restart it.
  if (state.paused && !state.finished) return { state: "processing", answers: new Map(), failed: state.failed.length };
  if (!state.finished && state.blocked && !running.has(job.id)) {
    // Paused for want of a local model: try again now (fails fast when there still is none).
    await runLocal(job);
    state = await loadLocal(job.id);
    if (state.blocked) throw new AiError("API_ERROR", new NoLocalModelError().message);
  }
  if (!state.finished && !running.has(job.id)) {
    // The tab was closed mid-run: resume in the background.
    void runLocal(job);
    state = await loadLocal(job.id);
  }
  const answers = new Map(Object.entries(state.answers));
  if (!state.finished) return { state: "processing", answers: new Map(), failed: state.failed.length };
  // Finished but not stored: applying now works; after a reload it would re-run.
  if (unsaved.has(job.id)) log.warn(`local batch ${job.id}: finished, but this device couldn't store the answers — apply them now`);
  return { state: "ended", answers, failed: state.failed.length };
}

/** Forget a local job's stored answers (after it was applied). */
export async function clearLocalBatch(id: string): Promise<void> {
  memory.delete(id);
  unsaved.delete(id);
  inFlight.get(id)?.abort();
  await idbDel(LOCAL_KEY(id)).catch(() => { /* why: the answers were applied already; a stale entry is overwritten by the next job with this id */ });
}

/** Tests: a reload — this session's in-memory state is gone, IndexedDB is not. */
export function __forgetSession(): void {
  for (const c of inFlight.values()) c.abort();
  inFlight.clear();
  memory.clear();
  unsaved.clear();
}

/** Tests: wait for a running local job. */
export function __localBatchRun(id: string): Promise<void> | undefined {
  return running.get(id);
}
