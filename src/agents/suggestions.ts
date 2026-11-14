/**
 * The improvement agent's hand-off to the user: when a command's agent run
 * ends without a usable answer, its suggestions are shown in the
 * suggestions panel (src/ui/AiSuggestionsPanel.tsx), and each suggestion
 * is an action that really runs — set the policy, pull a model, switch
 * executor, retry with a patch — after which the failed palette command
 * is run again.
 */

import type { AgentRun, ExecutorId, RetryPatch, Suggestion } from "./types";
// Type only: this module is in the startup bundle (the suggestions panel),
// and a value import would bring the whole agent runtime with it.
import type { AgentRunError } from "./runtime";

export interface SuggestionsEvent {
  run: AgentRun;
  /** Palette command to re-run after an action (the agent's command by default). */
  commandId?: string;
}

const listeners = new Set<(e: SuggestionsEvent) => void>();

export function onAgentSuggestions(fn: (e: SuggestionsEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function showAgentSuggestions(e: SuggestionsEvent): void {
  for (const l of listeners) l(e);
}

/**
 * For a command's catch block: an AgentRunError with suggestions opens the
 * panel (returns true, the caller stops); anything else returns false so
 * the caller shows its usual error.
 */
export function reportAgentFailure(e: unknown, commandId?: string): boolean {
  // AgentRunError by name (it sets it), so the runtime stays a lazy chunk.
  if (!(e instanceof Error) || e.name !== "AgentRunError" || !(e as AgentRunError).run) return false;
  const run = (e as AgentRunError).run;
  if (run.status === "aborted") return true;
  if (!run.suggestions?.length && !listeners.size) return false;
  showAgentSuggestions({ run, commandId: commandId ?? run.commandId });
  return listeners.size > 0;
}

/* ── "Not good" (5.6.3) ──────────────────────────────────────────────── */

/** A palette command's last good answer: the user may say it was not good. */
export interface AnswerEvent {
  run: AgentRun;
  commandId?: string;
}

const answerListeners = new Set<(e: AnswerEvent) => void>();

export function onAgentAnswer(fn: (e: AnswerEvent) => void): () => void {
  answerListeners.add(fn);
  return () => answerListeners.delete(fn);
}

/** Called by the runtime for every run that ended with an answer (not the parts of a split run). */
export function announceAnswer(e: AnswerEvent): void {
  for (const l of answerListeners) l(e);
}

/** Runs the user marked as not good, by id → the run that re-did them. */
const retried = new Map<string, string | null>();

/** The run that re-does `runId` (set when it starts), if any. */
export function retryOfPending(agentId: string, inputKey?: string): string | undefined {
  const p = pendingFor(agentId, inputKey);
  return p?.retryOf;
}

/**
 * "Not good": the answer of `run` is rejected. The next run of the same
 * agent on the same input gets a patch that says so (a new attempt at
 * temperature 0.7 that avoids the rejected answer, one tier up when there
 * is one) and records `retryOf: run.id`; the command is run again.
 */
export async function markNotGood(run: AgentRun, commandId?: string): Promise<void> {
  const [{ nextTier }, { getAgent }] = await Promise.all([import("./critic"), import("./registry")]);
  const tier = nextTier(getAgent(run.agentId)?.tier ?? "small") ?? undefined;
  const prev = typeof run.output === "string" ? run.output : JSON.stringify(run.output ?? "");
  const patch: RetryPatch = {
    temperature: 0.7,
    promptSuffix: `The user rejected this previous answer as not good; write a different, better one:\n${prev.slice(0, 1200)}`,
    ...(tier ? { tier } : {}),
  };
  retried.set(run.id, null);
  setNextRunPatch(run.agentId, patch, run.inputKey, run.id);
  rerunCommand(commandId ?? run.commandId);
}

/** Test hook: which runs were marked, and the run that re-did each (null until it finished). */
export function __retriedRuns(): ReadonlyMap<string, string | null> {
  return retried;
}

/** The runtime closes the loop: `retryRun` re-did `original`. */
export function noteRetried(original: string, retryRun: string): void {
  if (retried.has(original)) retried.set(original, retryRun);
}

/* ── One-shot overrides for the retry of a failed run ───────────────── */

/**
 * A patch picked in the panel applies once, to the run of the same agent
 * on the same input as the run that failed (`AgentRun.inputKey`): a
 * command that runs the agent several times (translation chunk by chunk)
 * re-runs the earlier inputs untouched — often from the cache — and the
 * patch waits for the input that failed. It expires after ten minutes.
 */
interface PendingPatch {
  patch: RetryPatch;
  inputKey?: string;
  expires: number;
  /** The run the user marked "not good" (5.6.3). */
  retryOf?: string;
}

const PATCH_TTL_MS = 10 * 60_000;
const nextPatch = new Map<string, PendingPatch>();

export function setNextRunPatch(agentId: string, patch: RetryPatch, inputKey?: string, retryOf?: string): void {
  const prev = nextPatch.get(agentId);
  const same = prev && prev.inputKey === inputKey && prev.expires > Date.now();
  const merged = same ? { ...prev.patch, ...patch } : patch;
  nextPatch.set(agentId, { patch: merged, inputKey, expires: Date.now() + PATCH_TTL_MS, retryOf: retryOf ?? (same ? prev.retryOf : undefined) });
}

function pendingFor(agentId: string, inputKey?: string): PendingPatch | undefined {
  const p = nextPatch.get(agentId);
  if (!p) return undefined;
  if (p.expires <= Date.now()) {
    nextPatch.delete(agentId);
    return undefined;
  }
  return !p.inputKey || p.inputKey === inputKey ? p : undefined;
}

/** The executor a pending patch forces for this input, without consuming it. */
export function peekNextRunExecutor(agentId: string, inputKey?: string): ExecutorId | undefined {
  return pendingFor(agentId, inputKey)?.patch.executor;
}

/**
 * Consumed by the runtime once it has tried to pick an executor for the
 * matching input — also when that pick failed, so a forced executor that
 * is still offline does not stay forced.
 */
export function takeNextRunPatch(agentId: string, inputKey?: string): RetryPatch | undefined {
  const p = pendingFor(agentId, inputKey);
  if (!p) return undefined;
  nextPatch.delete(agentId);
  return p.patch;
}

/** Ask the app to run a palette command again (App listens for this event). */
export function rerunCommand(commandId: string | undefined): void {
  if (!commandId || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: commandId } }));
}

export interface ActionContext {
  onProgress?: (text: string) => void;
  /** Stops a live check (the panel's close button). */
  signal?: AbortSignal;
  /** How long `check-ollama` waits (default two minutes) and how often it asks. */
  waitMs?: number;
  pollMs?: number;
}

/**
 * "Start Ollama" with a live check (5.6.5): the panel says what to run and
 * asks the server every two seconds until it answers (or the wait ends).
 * Resolves true when Ollama answered.
 */
export async function waitForOllama(ctx: ActionContext = {}): Promise<boolean> {
  const { isOllamaAvailable, getBaseUrl } = await import("../ai/ollamaProvider");
  const { t } = await import("../i18n");
  const until = Date.now() + (ctx.waitMs ?? 120_000);
  const poll = ctx.pollMs ?? 2000;
  for (;;) {
    if (ctx.signal?.aborted) return false;
    if (await isOllamaAvailable()) {
      ctx.onProgress?.(t("agent.suggest.ollamaUp", { url: getBaseUrl() }));
      const { refreshOllama } = await import("./executors/ollama");
      await refreshOllama(true).catch(() => undefined);
      return true;
    }
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (left <= 0) {
      ctx.onProgress?.(t("agent.suggest.ollamaStillDown", { url: getBaseUrl() }));
      return false;
    }
    ctx.onProgress?.(t("agent.suggest.ollamaWaiting", { url: getBaseUrl(), seconds: left }));
    await new Promise<void>((r) => {
      const timer = setTimeout(r, poll);
      ctx.signal?.addEventListener("abort", () => (clearTimeout(timer), r()), { once: true });
    });
  }
}

/**
 * Carry out one suggestion. Returns whether the failed command should be
 * run again afterwards.
 */
export async function runSuggestion(s: Suggestion, run: AgentRun, ctx: ActionContext = {}): Promise<boolean> {
  if (!s.action) return false;
  const rerun = await performSuggestion(s, run, ctx);
  // T30: remember the choice; the re-run's outcome is recorded against it.
  // Only once the action succeeded and a re-run follows — a failed or
  // unsupported action must not credit a later, unrelated run.
  if (rerun) {
    const { noteSuggestionChosen } = await import("./outcomes");
    noteSuggestionChosen(s, run);
  }
  return rerun;
}

async function performSuggestion(s: Suggestion, run: AgentRun, ctx: ActionContext): Promise<boolean> {
  const a = s.action;
  if (!a) return false;
  switch (a.type) {
    case "retry":
      setNextRunPatch(run.agentId, a.patch, run.inputKey);
      return true;
    case "switch-executor":
      setNextRunPatch(run.agentId, { executor: a.executor as ExecutorId }, run.inputKey);
      return true;
    case "set-policy": {
      const { setAiPolicy } = await import("../ai/policy");
      setAiPolicy(a.policy);
      return true;
    }
    case "pull-model": {
      if (a.executor === "ollama") {
        const { pullOllamaModel } = await import("../ai/ollamaProvider");
        for await (const ev of pullOllamaModel(a.model)) {
          const pct = ev.total ? Math.round(((ev.completed ?? 0) / ev.total) * 100) : null;
          ctx.onProgress?.(pct === null ? ev.status : `${ev.status} ${pct}%`);
        }
        const { refreshOllama } = await import("./executors/ollama");
        await refreshOllama(true).catch(() => undefined);
        return true;
      }
      if (a.executor === "webllm") {
        const { loadWebLlmModel, onWebLlmProgress } = await import("../ai/webllmEngine");
        const off = onWebLlmProgress((p) => ctx.onProgress?.(`${Math.round(p.progress * 100)}% ${p.text}`));
        try {
          await loadWebLlmModel(a.model);
        } finally {
          off();
        }
        return true;
      }
      return false;
    }
    case "open-docs": {
      const { docsUrl } = await import("../lib/docsLinks");
      const key = a.key === "localAgents" || a.key === "localLlm" ? a.key : "localLlm";
      window.open(docsUrl(key), "_blank", "noopener");
      return false;
    }
    case "split-input": {
      // The user picks a part (the commands work on the selection when there is one): say so.
      const { t } = await import("../i18n");
      ctx.onProgress?.(t("agent.suggest.splitInput.done"));
      return false;
    }
    case "check-ollama":
      return waitForOllama(ctx);
    case "run-command":
      rerunCommand(a.id);
      return false;
  }
  return false;
}
