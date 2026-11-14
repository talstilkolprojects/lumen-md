/**
 * The improvement agent ("critic") — what to do when there is no usable
 * answer.
 *
 * Stage 1 (this file) is deterministic and always available: it maps a
 * failure to one concrete change for a retry (temperature 0, a larger
 * model tier, the validator's error fed back, a split) and to suggestions
 * the user can act on (start Ollama, allow the app's origin, pull a model,
 * try another executor, split the document, allow the cloud). Stage 2 — a
 * local model that diagnoses the failure and proposes its own patch — plugs
 * in through `setModelCritic()` and runs only when stage 1 has nothing
 * specific to say.
 */

import type { Availability, ExecutorId, ModelTier, RetryPatch, Suggestion } from "./types";
import { MODEL_TIERS } from "./types";

export type FailureKind = "no-executor" | "validation" | "parse" | "empty" | "tool" | "error" | "aborted";

export interface Failure {
  kind: FailureKind;
  /** The agent that failed (the model critic never reviews itself). */
  agentId?: string;
  /** 1-based attempt that failed. */
  attempt: number;
  maxRetries: number;
  tier: ModelTier;
  executor: ExecutorId | null;
  /** Validator / tool name. */
  label?: string;
  reason?: string;
  hint?: string;
  /** Characters of input the agent was given. */
  inputChars?: number;
  /** The agent can run on parts of its input (AgentDefinition.splittable). */
  splittable?: boolean;
  /** For `no-executor`: why each executor was skipped. */
  skipped?: Array<{ id: ExecutorId; availability: Availability }>;
  /** Executors that could take a retry. */
  alternatives?: ExecutorId[];
  /** The run's cancellation: the model critic's own request honours it. */
  signal?: AbortSignal;
}

export interface Verdict {
  /** A change worth retrying with; absent when retrying is pointless. */
  retry?: RetryPatch;
  /** The retry comes from the model critic's own diagnosis: the runtime gives it one attempt past the limit (5.6.1). */
  byModel?: boolean;
  suggestions: Suggestion[];
  /** Short machine-readable diagnosis (`cors`, `ollama-offline`, `context`…). */
  diagnosis: string;
}

export type ModelCritic = (failure: Failure, stage1: Verdict) => Promise<Verdict | null>;

let modelCritic: ModelCritic | null = null;

/** Stage 2 hook (installed by the model-based critic once it exists). */
export function setModelCritic(fn: ModelCritic | null): void {
  modelCritic = fn;
}

export function nextTier(tier: ModelTier): ModelTier | null {
  const i = MODEL_TIERS.indexOf(tier);
  return i >= 0 && i < MODEL_TIERS.length - 1 ? MODEL_TIERS[i + 1] : null;
}

const LONG_INPUT = 6000;
/** Size of a part when the user asks to split the document (5.6.2). */
export const SPLIT_SIZE = 4000;

function s(id: string, title: string, extra: Partial<Suggestion> = {}): Suggestion {
  return { id, title, ...extra };
}

/** Classify an executor error message. */
export function classifyError(message: string): string {
  const m = message.toLowerCase();
  if (/\b403\b|forbidden|cors|access-control|origin/.test(m)) return "cors";
  if (/\b404\b|not found|no such model|model .* not found|pull/.test(m)) return "model-missing";
  if (/context|too long|maximum context|exceeds|token limit/.test(m)) return "context";
  if (/failed to fetch|networkerror|econnrefused|connection|timeout|timed out|unreachable/.test(m)) return "offline";
  if (/out of memory|oom|allocation|buffer/.test(m)) return "memory";
  if (/abort/.test(m)) return "aborted";
  return "error";
}

function availabilitySuggestions(skipped: Failure["skipped"] = []): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (x: Suggestion) => {
    if (!seen.has(x.id)) {
      seen.add(x.id);
      out.push(x);
    }
  };
  for (const { id, availability } of skipped) {
    switch (availability.reason) {
      case "ollama-offline":
        push(s("start-ollama", "agent.suggest.startOllama", { detail: "agent.suggest.startOllama.detail", action: { type: "check-ollama" } }));
        break;
      case "cors":
        push(s("ollama-origins", "agent.suggest.ollamaOrigins", { detail: "agent.suggest.ollamaOrigins.detail", action: { type: "open-docs", key: "localAgents" } }));
        break;
      case "no-webgpu":
        push(s("use-ollama", "agent.suggest.useOllama", { detail: "agent.suggest.useOllama.detail", action: { type: "switch-executor", executor: "ollama" } }));
        push(s("webgpu-browser", "agent.suggest.webgpuBrowser", { detail: "agent.suggest.webgpuBrowser.detail", action: { type: "open-docs", key: "localLlm" } }));
        break;
      case "no-local":
        // A cloud provider is selected under local-only and nothing local can answer.
        push(s("start-ollama", "agent.suggest.startOllama", { detail: "agent.suggest.startOllama.detail", action: { type: "check-ollama" } }));
        push(s("webgpu-browser", "agent.suggest.webgpuBrowser", { detail: "agent.suggest.webgpuBrowser.detail", action: { type: "open-docs", key: "localLlm" } }));
        push(s("allow-cloud", "agent.suggest.allowCloud", { detail: "agent.suggest.allowCloud.detail", action: { type: "set-policy", policy: "local-first" } }));
        break;
      case "no-model":
        push(s("pull-model", "agent.suggest.pullModel", { params: { model: availability.detail ?? "" }, action: { type: "pull-model", executor: id, model: availability.detail ?? "" } }));
        break;
      case "policy":
        push(s("allow-cloud", "agent.suggest.allowCloud", { detail: "agent.suggest.allowCloud.detail", action: { type: "set-policy", policy: "local-first" } }));
        break;
      case "no-key":
        push(s("use-ollama", "agent.suggest.useOllama", { detail: "agent.suggest.useOllama.detail", action: { type: "switch-executor", executor: "ollama" } }));
        push(s("configure-key", "agent.suggest.configureKey", { params: { provider: availability.detail ?? "" }, action: { type: "run-command", id: "ai.switchProvider" } }));
        break;
      default:
        break;
    }
  }
  if (!out.length) push(s("start-ollama", "agent.suggest.startOllama", { detail: "agent.suggest.startOllama.detail", action: { type: "check-ollama" } }));
  return out;
}

/** Split the document (5.6.2) when the agent can; otherwise ask for a smaller selection. */
function splitSuggestion(f: Failure): Suggestion {
  return f.splittable && (f.inputChars ?? 0) > SPLIT_SIZE
    ? s("split-input", "agent.suggest.splitDocument", { detail: "agent.suggest.splitDocument.detail", params: { size: SPLIT_SIZE }, action: { type: "retry", patch: { split: SPLIT_SIZE } } })
    : s("select-part", "agent.suggest.splitInput", { detail: "agent.suggest.splitInput.detail", action: { type: "split-input" } });
}

/** Stage 1: deterministic diagnosis. */
export function diagnose(f: Failure): Verdict {
  const retriesLeft = f.attempt <= f.maxRetries;
  const up = nextTier(f.tier);
  const long = (f.inputChars ?? 0) > LONG_INPUT;
  const suggestions: Suggestion[] = [];

  if (f.kind === "aborted") return { suggestions: [], diagnosis: "aborted" };

  if (f.kind === "no-executor") {
    return { suggestions: availabilitySuggestions(f.skipped), diagnosis: f.skipped?.[0]?.availability.reason ?? "no-executor" };
  }

  if (f.kind === "error") {
    const cls = classifyError(f.reason ?? "");
    if (cls === "cors") return { suggestions: availabilitySuggestions([{ id: f.executor ?? "chat", availability: { available: false, reason: "cors" } }]), diagnosis: "cors" };
    if (cls === "model-missing") {
      const model = (f.reason ?? "").match(/model\s+"?([\w.:/-]+)"?/i)?.[1] ?? "";
      return {
        suggestions: [s("pull-model", "agent.suggest.pullModel", { params: { model }, action: { type: "pull-model", executor: f.executor ?? "ollama", model } })],
        diagnosis: "model-missing",
      };
    }
    if (cls === "context" || cls === "memory") {
      return {
        retry: retriesLeft ? { promptSuffix: "Be concise.", temperature: 0 } : undefined,
        suggestions: [splitSuggestion(f)],
        diagnosis: cls,
      };
    }
    if (cls === "offline") return { suggestions: availabilitySuggestions([{ id: f.executor ?? "chat", availability: { available: false, reason: "ollama-offline" } }]), diagnosis: "offline" };
    // Unknown error: one plain retry, then suggest another executor.
    if (retriesLeft) return { retry: {}, suggestions: [], diagnosis: "error" };
    for (const alt of f.alternatives ?? []) suggestions.push(s(`switch-${alt}`, "agent.suggest.switchExecutor", { params: { executor: alt }, action: { type: "switch-executor", executor: alt } }));
    return { suggestions, diagnosis: "error" };
  }

  // validation / parse / empty / tool: feed the error back, then climb a tier.
  const feedback = [f.reason ? `Previous answer was rejected: ${f.reason}.` : "", f.hint ?? ""].filter(Boolean).join(" ");
  let retry: RetryPatch | undefined;
  if (retriesLeft) {
    retry = { temperature: 0, promptSuffix: feedback || "The previous answer was unusable. Follow the format exactly." };
    if (f.attempt >= 2 && up) retry.tier = up;
    if (f.kind === "empty" && !retry.tier && up) retry.tier = up;
  }
  if (!retriesLeft) {
    if (up) suggestions.push(s("larger-model", "agent.suggest.largerModel", { params: { tier: up }, action: { type: "retry", patch: { tier: up, temperature: 0, promptSuffix: feedback } } }));
    if (long) suggestions.push(splitSuggestion(f));
    for (const alt of f.alternatives ?? []) suggestions.push(s(`switch-${alt}`, "agent.suggest.switchExecutor", { params: { executor: alt }, action: { type: "switch-executor", executor: alt } }));
    suggestions.push(s("retry", "agent.suggest.retry", { action: { type: "retry", patch: { temperature: 0.4, promptSuffix: feedback } } }));
  }
  return { retry, suggestions, diagnosis: f.kind === "tool" ? "tool" : long ? "long-input" : f.kind };
}

/** T30: the suggestions that worked on this machine for this diagnosis come first. */
async function learned(v: Verdict, f: Failure): Promise<Verdict> {
  if (v.suggestions.length < 2) return v;
  try {
    const { rankByOutcomes } = await import("./outcomes");
    return { ...v, suggestions: await rankByOutcomes(v.suggestions, v.diagnosis, f.agentId) };
  } catch {
    return v;
  }
}

/** Full verdict: stage 1, then the model critic when installed and stage 1 is generic. */
export async function review(f: Failure): Promise<Verdict> {
  const v = await learned(diagnose(f), f);
  // Stage 2 only when stage 1 has no retry left to offer: it costs a model
  // call, and its job is better suggestions for the user, not the retry.
  const generic = ["validation", "parse", "empty", "error", "tool", "long-input"].includes(v.diagnosis);
  if (modelCritic && generic && !v.retry && f.kind !== "aborted" && !f.signal?.aborted) {
    try {
      const m = await modelCritic(f, v);
      if (m) return learned({ ...v, ...m, byModel: !!m.retry, suggestions: m.suggestions.length ? m.suggestions : v.suggestions }, f);
    } catch {
      /* why: stage 2 is best effort */
    }
  }
  return v;
}
