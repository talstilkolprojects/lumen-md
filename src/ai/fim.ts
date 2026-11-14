/**
 * Plan 6.9 — local autocomplete in the editor (fill-in-the-middle), the
 * replacement for a cloud Copilot. Lazy: loaded on the first keystroke
 * after the user turned it on.
 *
 *   1. Ollama `/api/generate` with `suffix` on an installed qwen2.5-coder
 *      1.5B / 7B (Apache-2.0; never the 3B) — on this machine or network
 *      only, whatever the AI policy;
 *   2. else the in-browser model, but only one already loaded in this tab
 *      (a keystroke never starts a model download), through the
 *      `completer` agent;
 *   3. else nothing. There is no cloud route at all.
 *
 * Every keystroke cancels the request in flight (FimScheduler in the
 * editor); answers are cached per context; the latency of each completion
 * is kept, and its p50 / p95 go to the agent trace.
 */
import { isLocalOrigin } from "./policy";
import { FimCache, cleanFim, fimRequestBody, percentile, pickFimModel } from "./fimCore";
import { log } from "../lib/logger";

export const FIM_ENABLED_KEY = "lumen.fim.enabled";
export const FIM_MODEL_KEY = "lumen.fim.model";

export function fimEnabled(): boolean {
  try {
    return localStorage.getItem(FIM_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setFimEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(FIM_ENABLED_KEY, "1");
    else localStorage.removeItem(FIM_ENABLED_KEY);
  } catch {
    /* why: storage blocked: stays as it was */
  }
}

export interface FimResult {
  text: string;
  engine: "ollama" | "webllm";
  model: string;
  /** Time from the request to the answer (0 for a cache hit). */
  ms: number;
  cached: boolean;
}

const cache = new FimCache(64);
/** The FIM model on the configured Ollama, re-checked once a minute (installs change). */
let modelProbe: { at: number; model: string | null } | null = null;
const MODEL_TTL_MS = 60_000;

function preferredModel(): string | null {
  try {
    return localStorage.getItem(FIM_MODEL_KEY);
  } catch {
    return null;
  }
}

/** The Ollama FIM model, or null when there is none — or the Ollama is not on this machine / network. */
export async function ollamaFimModel(now = Date.now()): Promise<string | null> {
  const { getBaseUrl, listOllamaModels } = await import("./ollamaProvider");
  if (!isLocalOrigin(getBaseUrl())) return null;
  if (modelProbe && now - modelProbe.at < MODEL_TTL_MS) return modelProbe.model;
  const installed = (await listOllamaModels()).map((m) => m.name);
  modelProbe = { at: now, model: pickFimModel(installed, preferredModel()) };
  return modelProbe.model;
}

/* ─── latency → trace ─────────────────────────────────────────────────── */

const latencies: number[] = [];
const LATENCY_WINDOW = 50;
let lastTraced = 0;
const TRACE_EVERY_MS = 30_000;

/** p50 / p95 over the last completions (ms), for the AI doctor and the trace. */
export function fimLatency(): { n: number; p50: number | null; p95: number | null } {
  return { n: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95) };
}

async function traceLatency(r: FimResult, startedAt: number, tokens: { input: number; output: number }): Promise<void> {
  latencies.push(r.ms);
  if (latencies.length > LATENCY_WINDOW) latencies.shift();
  // One trace entry per half minute at most: a completion per keystroke pause
  // must not push the agents' runs out of the trace.
  if (startedAt - lastTraced < TRACE_EVERY_MS) return;
  lastTraced = startedAt;
  const { p50, p95, n } = fimLatency();
  const { recordRun } = await import("../agents/trace");
  await recordRun({
    id: `fim-${startedAt.toString(36)}`,
    agentId: "fim",
    commandId: "editor.fim",
    executor: r.engine,
    model: r.model,
    startedAt,
    endedAt: startedAt + r.ms,
    status: "ok",
    output: r.text,
    attempts: 1,
    steps: [{ kind: "model", at: startedAt, ms: r.ms, label: `fim ${r.model}`, ok: true, detail: `p50 ${p50} ms · p95 ${p95} ms over the last ${n} completions` }],
    suggestions: [],
    tokens: { input: tokens.input, output: tokens.output, estimated: false },
  });
}

/* ─── completion ──────────────────────────────────────────────────────── */

async function viaOllama(model: string, prefix: string, suffix: string, signal?: AbortSignal): Promise<{ text: string; tokens: { input: number; output: number } }> {
  const { getBaseUrl } = await import("./ollamaProvider");
  const res = await fetch(`${getBaseUrl()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fimRequestBody(model, prefix, suffix)),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama generate ${res.status}`);
  const data = (await res.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number };
  return { text: cleanFim(data.response ?? "", suffix), tokens: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 } };
}

async function viaWebLlm(prefix: string, suffix: string, signal?: AbortSignal): Promise<{ text: string; model: string } | null> {
  const { loadedWebLlmModel } = await import("./webllmEngine");
  const model = loadedWebLlmModel();
  if (!model) return null;
  const [{ runAgentOrThrow }, { completerAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
  // Local and free: nothing to charge (prepaid); the runtime traces it.
  const raw = await runAgentOrThrow(completerAgent, { text: prefix, extra: { mode: "ghost" } }, { executor: "webllm", signal, prepaid: true });
  return { text: cleanFim(raw, suffix), model };
}

/**
 * Complete the text between `prefix` and `suffix`. Null when no local
 * engine is available, the request was cancelled, or there is nothing to add.
 */
export async function completeFim(prefix: string, suffix: string, opts: { signal?: AbortSignal } = {}): Promise<FimResult | null> {
  if (prefix.trim().length < 3) return null;
  const startedAt = Date.now();
  const t0 = performance.now();
  try {
    const model = await ollamaFimModel().catch(() => null);
    if (opts.signal?.aborted) return null;
    if (model) {
      const key = FimCache.key(model, prefix, suffix);
      const hit = cache.get(key);
      if (hit !== undefined) return hit ? { text: hit, engine: "ollama", model, ms: 0, cached: true } : null;
      const { text, tokens } = await viaOllama(model, prefix, suffix, opts.signal);
      if (opts.signal?.aborted) return null;
      cache.set(key, text);
      if (!text) return null;
      const r: FimResult = { text, engine: "ollama", model, ms: Math.round(performance.now() - t0), cached: false };
      void traceLatency(r, startedAt, tokens).catch(() => { /* why: latency tracing is best effort; the completion is already returned */ });
      return r;
    }
    const web = await viaWebLlm(prefix, suffix, opts.signal);
    if (!web || !web.text || opts.signal?.aborted) return null;
    const r: FimResult = { text: web.text, engine: "webllm", model: web.model, ms: Math.round(performance.now() - t0), cached: false };
    latencies.push(r.ms);
    if (latencies.length > LATENCY_WINDOW) latencies.shift();
    return r;
  } catch (e) {
    if (!opts.signal?.aborted) log.debug("fim", e);
    return null;
  }
}

/** Tests. */
export function __resetFim(): void {
  cache.clear();
  modelProbe = null;
  latencies.length = 0;
  lastTraced = 0;
}
