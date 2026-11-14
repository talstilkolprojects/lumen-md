/**
 * Centralized LLM service for all AI agents.
 * Single point for API calls, streaming, abort, retry, and error handling.
 */

import { AiQuotaExceededError, aiQuotaStatus, chargeAiCommandDispatch, consumeAiPrompt } from "../billing/aiQuota";
import { useAppStore } from "../store/useStore";
import { toast } from "../store/useToastStore";
import { fetchWithRetry } from "../lib/fetchRetry";
import { t } from "../i18n";
import { docsUrl } from "../lib/docsLinks";
import { estimateTokens, recordCacheHit, recordUsage, type Usage } from "./usage";
import { cloudAllowed, getAiPolicy, isCloudProvider, isLocalOrigin, providerAllowed } from "./policy";
import { getSecret } from "../lib/secretStore";
import { getOllamaConfigModel } from "./ollamaProvider";

// ── Rate limiting ───────────────────────────────────────────────────────
// Token bucket — protects the user's API key against runaway loops.
const RATE_LIMIT_PER_MIN = 60;
const MAX_CONCURRENT = 5;
const requestTimestamps: number[] = [];
let inflight = 0;

class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`Rate limit exceeded. Retry in ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = "RateLimitError";
  }
}

function checkRateLimit(): void {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  // Drop timestamps older than 1 minute.
  while (requestTimestamps.length && requestTimestamps[0] < oneMinuteAgo) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_PER_MIN) {
    const oldest = requestTimestamps[0];
    const retryAfterMs = 60_000 - (now - oldest);
    toast.warn(
      t("ai.toast.rateLimit.title"),
      t("ai.toast.rateLimit.body", { seconds: Math.ceil(retryAfterMs / 1000) }),
    );
    throw new RateLimitError(retryAfterMs);
  }
  if (inflight >= MAX_CONCURRENT) {
    toast.warn(t("ai.toast.capacity.title"), t("ai.toast.capacity.body"));
    throw new RateLimitError(1_000);
  }
  requestTimestamps.push(now);
}

/**
 * Run one provider request under the same per-minute and concurrency limits
 * as `chat()` — for calls that go to a provider outside `chatDirect`
 * (Claude web research and its continuations).
 */
export async function withRequestLimit<T>(send: () => Promise<T>, charge?: () => void): Promise<T> {
  checkRateLimit();
  // Like chatDirect: the quota is charged only once the request may go out.
  charge?.();
  inflight++;
  try {
    return await send();
  } finally {
    inflight--;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** If true, returns a ReadableStream for streaming responses. */
  stream?: boolean;
  /**
   * The caller already counted this request against the AI quota
   * (`consumeAiPrompt`), so it must not also be billed to a palette
   * command that is waiting to dispatch.
   */
  prepaid?: boolean;
  /**
   * A non-palette request (Ctrl-Space, inline suggestions, Ask Workspace,
   * voice-memo summary, …) that pays for ITSELF — at dispatch, after the
   * provider / key / rate-limit checks, so a request that fails locally
   * spends nothing — and never takes a waiting palette command's
   * reservation. `"silent"`: no toast when the quota is spent (background
   * callers); the request just doesn't go out.
   */
  ownPrompt?: boolean | "silent";
  /**
   * Charges the quota instead of `prepaid` / `ownPrompt` — the agent
   * runtime's once-per-run charge, called at dispatch like the others.
   */
  chargeHook?: () => void;
  /**
   * Reuse an identical earlier answer from the local response cache (and
   * store this one). Only for deterministic transformations of the given
   * text; ignored when the user turned the cache off.
   */
  cache?: boolean;
  /**
   * "light": a small task (tags, titles, outline, completions). In the
   * economy / balanced AI modes it goes to the provider's small model
   * unless `model` pins one. Economy mode routes every unpinned request.
   */
  tier?: "light" | "heavy";
  /**
   * With `cache`: store the answer only when this accepts it (e.g. it
   * parses), so a malformed answer is retried next time, not replayed.
   */
  cacheIf?: (text: string) => boolean;
  /**
   * Internal: providers report token usage here (exact where the API
   * returns it). `provider` overrides the selected one when the request
   * was routed elsewhere (fallbacks, local WebGPU).
   */
  onUsage?: (u: Omit<Usage, "provider"> & { provider?: string }) => void;
  /** Internal: the provider a fallback actually sent the request to. */
  onRoute?: (provider: AiProvider, model: string) => void;
  /**
   * Internal: `model` was chosen by the model router for the selected
   * provider, not pinned by the caller — a local reroute must drop it.
   */
  modelFromRouter?: boolean;
}

const DEFAULT_MODEL = "gpt-4o-mini";
/** Each cloud provider's model when the user hasn't picked one (the provider modules use these). */
export const PROVIDER_DEFAULT_MODELS = {
  // The in-browser default when the user picked none and the GPU wasn't
  // probed yet; the model manager (./modelManager.ts) picks by hardware.
  "local-webgpu": "Qwen3-4B-q4f16_1-MLC",
  // Sonnet 4.5 is deprecated (retires 30 Nov 2026); Sonnet 5.5 is the current general model.
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-1.5-flash",
  mistral: "mistral-small-latest",
} as const;
const API_URL = "https://api.openai.com/v1/chat/completions";
const MAX_RETRIES = 2;

/**
 * Get the current AI key from the store.
 * Throws a user-friendly error if not configured.
 */
export function getAiKey(): string {
  const key = useAppStore.getState().aiKey;
  if (!key) {
    throw new AiError("NO_KEY", "Please configure your AI Key (⌘K → AI Settings).");
  }
  return key;
}

export class AiError extends Error {
  constructor(
    public code: "NO_KEY" | "API_ERROR" | "PARSE_ERROR" | "ABORTED" | "POLICY" | "NO_LOCAL",
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/**
 * The AI policy gate (./policy.ts). A cloud provider is contacted only
 * when the policy allows it: as the selected provider under `cloud` /
 * `local-first`, or as the fallback when a local provider is unavailable
 * under `local-first`. Under `local-only` the request stops here with a
 * clear code instead of silently reaching a third party.
 */
function assertCloudProvider(provider: AiProvider): void {
  if (!providerAllowed(provider)) {
    throw new AiError("POLICY", `AI policy is "${getAiPolicy()}": ${provider} is a cloud provider and was not contacted.`);
  }
}

/**
 * Where a request goes when a CLOUD provider is selected but the policy
 * prefers local backends:
 *
 *   local-first  a reachable Ollama server, else in-browser WebGPU when the
 *                user turned Privacy Mode on (never a surprise multi-GB
 *                download for someone who picked a cloud provider), else
 *                null — the cloud provider answers.
 *   local-only   Ollama, else WebGPU, else NO_LOCAL — the cloud provider is
 *                never contacted.
 *   cloud        null.
 *
 * A selected local provider returns null and takes the normal branches.
 */
async function localRoute(provider: AiProvider): Promise<"ollama" | "local-webgpu" | null> {
  if (!isCloudProvider(provider)) return null;
  const policy = getAiPolicy();
  if (policy === "cloud") return null;
  const { isOllamaAvailable, getBaseUrl } = await import("./ollamaProvider");
  // A custom Ollama URL on a public origin is a third party, not a local route.
  if (isLocalOrigin(getBaseUrl()) && (await isOllamaAvailable())) return "ollama";
  if (policy === "local-only" || useAppStore.getState().useLocalAi) {
    const { localLlmAvailable } = await import("./localLlm");
    if (localLlmAvailable().available) return "local-webgpu";
  }
  if (policy === "local-only") {
    throw new AiError("NO_LOCAL", `AI policy is "local-only": ${provider} is a cloud provider and no local backend (Ollama, WebGPU) is available.`);
  }
  return null;
}

/** Under `local-only`, an Ollama server off this machine / network is a third party. */
function assertOllamaOrigin(baseUrl: string): void {
  if (getAiPolicy() === "local-only" && !isLocalOrigin(baseUrl)) {
    throw new AiError("POLICY", `AI policy is "local-only": the Ollama server at ${baseUrl} is not on this machine or network.`);
  }
}

function assertCloudFallback(unavailable: string): void {
  if (!cloudAllowed()) {
    throw new AiError("NO_LOCAL", `${unavailable} is unavailable and the AI policy is "local-only", so no cloud fallback was used.`);
  }
}

/**
 * Send a chat completion request. Returns the full text response.
 *
 * When the user has flipped `useLocalAi` in the store and WebGPU is
 * available, the call is routed to `chatLocal()` instead of OpenAI.
 * This keeps prompts on-device for privacy / offline scenarios.
 */
export type AiProvider =
  | "openai"
  | "ollama"
  | "local-webgpu"
  | "anthropic"
  | "gemini"
  | "mistral";

const KNOWN_PROVIDERS: AiProvider[] = [
  "openai",
  "ollama",
  "local-webgpu",
  "anthropic",
  "gemini",
  "mistral",
];

export function getActiveProvider(): AiProvider {
  try {
    const stored = localStorage.getItem("lumen.ai.provider") as AiProvider | null;
    if (stored && KNOWN_PROVIDERS.includes(stored)) return stored;
  } catch { /* */ }
  const state = useAppStore.getState();
  if (state.useLocalAi) return "local-webgpu";
  return "openai";
}

export function setActiveProvider(provider: AiProvider): void {
  localStorage.setItem("lumen.ai.provider", provider);
}

/**
 * Return the API key for a cloud provider. Per-provider keys live in
 * the encrypted secret store (`lumen.ai.key.<provider>`, see lib/secretStore); OpenAI falls back to the primary
 * `aiKey` in the store for backwards compatibility. Throws if none is set.
 */
export function getProviderKey(provider: AiProvider): string {
  let key = "";
  try {
    key = getSecret(`lumen.ai.key.${provider}`) ?? "";
  } catch { /* */ }
  if (!key && provider === "openai") key = useAppStore.getState().aiKey ?? "";
  if (!key) {
    throw new AiError(
      "NO_KEY",
      `Please configure your ${provider} API key (⌘K → AI Settings).`,
    );
  }
  return key;
}

/**
 * The model a request to `provider` will use, for cache keys and the usage
 * meter (the provider modules resolve it the same way).
 */
export function effectiveModel(provider: AiProvider, opts: ChatOptions = {}): string {
  if (opts.model) return opts.model;
  if (provider === "openai") {
    const s = useAppStore.getState();
    return (s.useFineTunedModel && s.fineTunedModelId) || DEFAULT_MODEL;
  }
  try {
    // Ollama keeps its model where the Ollama picker writes it.
    if (provider === "ollama") return getOllamaConfigModel(); // same default the provider runs (plan 1.7)
    const fallback = (PROVIDER_DEFAULT_MODELS as Record<string, string>)[provider] ?? "default";
    return localStorage.getItem(`lumen.ai.model.${provider}`) || fallback;
  } catch {
    return "default";
  }
}

/** Each cloud provider's small, cheap model for light tasks. */
export const LIGHT_MODELS: Partial<Record<AiProvider, string>> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-5-5",
  gemini: "gemini-2.5-flash",
  mistral: "mistral-small-latest",
};

/**
 * Model router (Plan D: D4): picks the small model for light tasks (and,
 * in economy mode, for everything) unless the caller pinned a model.
 * Local providers are never rerouted.
 */
export function routeOptions(provider: AiProvider, opts: ChatOptions, mode: "economy" | "balanced" | "quality"): ChatOptions {
  if (opts.model || mode === "quality") return opts;
  const light = LIGHT_MODELS[provider];
  if (!light) return opts;
  if (opts.tier === "light" || mode === "economy") return { ...opts, model: light, modelFromRouter: true };
  return opts;
}

/** Options for a request rerouted to a local backend: a router-chosen cloud model name must not travel with it. */
function forLocal(opts: ChatOptions): ChatOptions {
  return opts.modelFromRouter ? { ...opts, model: undefined, modelFromRouter: false } : opts;
}

async function routed(provider: AiProvider, opts: ChatOptions): Promise<ChatOptions> {
  const { getAiMode } = await import("./contextPacker");
  return routeOptions(provider, opts, getAiMode());
}

const promptChars = (messages: ChatMessage[]) => messages.map((m) => m.content).join("\n");

/**
 * Send a chat completion request. Returns the full text response.
 * Answers may come from the local response cache (`opts.cache`); every
 * request that goes out is recorded in the usage meter.
 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const provider = getActiveProvider();
  const opts = await routed(provider, options);
  const model = effectiveModel(provider, opts);
  const { aiCacheEnabled, cacheKey, getCached, putCached } = await import("./responseCache");
  const key =
    opts.cache && aiCacheEnabled()
      ? await cacheKey({
          v: 1,
          provider,
          model,
          // Two Ollama servers can serve different weights under one name.
          endpoint: provider === "ollama" ? (localStorage.getItem("lumen.ollama.baseUrl") ?? "default") : null,
          messages,
          maxTokens: opts.maxTokens ?? null,
          temperature: opts.temperature ?? null,
        }).catch(() => null)
      : null;
  if (key) {
    const hit = await getCached(key);
    if (hit) {
      recordCacheHit(provider, model);
      return hit.text;
    }
  }
  let reported = false;
  // Fallbacks (Ollama / WebGPU unavailable → OpenAI) answer under another
  // provider: such an answer must not be cached under the selected one.
  let answeredBy: string = provider;
  let sentModel = model;
  const text = await chatDirect(messages, {
    ...opts,
    onRoute: (p, m) => {
      answeredBy = p;
      sentModel = m;
    },
    onUsage: (u) => {
      reported = true;
      answeredBy = u.provider ?? provider;
      recordUsage({ ...u, provider: answeredBy });
    },
  });
  if (text && !reported) {
    recordUsage({
      provider: answeredBy,
      model: sentModel,
      inputTokens: estimateTokens(promptChars(messages)),
      outputTokens: estimateTokens(text),
      estimated: true,
    });
  }
  if (key && text && answeredBy === provider && (!opts.cacheIf || opts.cacheIf(text))) await putCached(key, text, model);
  return text;
}

async function chatDirect(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  // The monthly quota is charged right before a request actually goes out
  // (after availability, key and rate-limit checks), so a request that
  // fails locally never spends a prompt.
  const charge = () => {
    if (opts.chargeHook) return opts.chargeHook();
    if (opts.prepaid) return;
    if (opts.ownPrompt) {
      if (!consumeAiPrompt(new Date(), { silent: opts.ownPrompt === "silent" })) {
        throw new AiQuotaExceededError(aiQuotaStatus(new Date()).limit);
      }
      return;
    }
    chargeAiCommandDispatch();
  };
  const provider = getActiveProvider();
  // At the monthly limit nothing goes out — not even the local probe.
  if (!opts.prepaid && !opts.chargeHook && !aiQuotaStatus(new Date()).allowed) charge();
  let localFirst = await localRoute(provider);

  // ── Ollama (local server) ──────────────────────────────────────
  if (provider === "ollama" || localFirst === "ollama") {
    const { chatOllama, isOllamaAvailable, getBaseUrl } = await import("./ollamaProvider");
    assertOllamaOrigin(getBaseUrl());
    if (await isOllamaAvailable()) {
      charge();
      const local = forLocal(opts);
      opts.onRoute?.("ollama", effectiveModel("ollama", local));
      return chatOllama(messages, local);
    }
    // A transient failure between the two probes: the selected provider
    // takes the request again (never a different cloud provider).
    if (localFirst === "ollama") localFirst = await localRoute(provider);
    toast.warn(
      t("ai.toast.ollamaUnavailable.title"),
      t("ai.toast.ollamaUnavailable.body", { url: getBaseUrl() }),
    );
    // Ollama is unreachable. Under `local-only` the request stops here.
    // Otherwise execution continues below: the anthropic / gemini / mistral
    // branches only match their own provider id, so they are skipped; the
    // WebGPU branch runs only if `useLocalAi` is on; and otherwise we reach
    // the OpenAI request at the end of this function, which throws NO_KEY
    // when no OpenAI key is configured.
    if (!useAppStore.getState().useLocalAi) assertCloudFallback("Ollama");
  }

  // ── WebGPU local (in-browser) ──────────────────────────────────
  if (provider === "local-webgpu" || localFirst === "local-webgpu" || (!isCloudProvider(provider) && useAppStore.getState().useLocalAi)) {
    const { chatLocal, localLlmAvailable, onLocalLlmProgress } = await import(
      "./localLlm"
    );
    if (localLlmAvailable().available) {
      let lastPct = -1;
      const off = onLocalLlmProgress(({ progress, text }) => {
        const pct = Math.round(progress * 100);
        if (pct >= lastPct + 5 || pct === 100) {
          lastPct = pct;
          toast.info(
            t("ai.toast.localLoading.title"),
            t("ai.toast.localLoading.body", {
              pct,
              status: text || t("ai.toast.localLoading.preparing"),
            }),
          );
        }
      });
      try {
        charge();
        const localModel = forLocal(opts).model;
        const text = await chatLocal(messages, { model: localModel, maxTokens: opts.maxTokens, temperature: opts.temperature });
        opts.onUsage?.({
          provider: "local-webgpu",
          model: localModel ?? PROVIDER_DEFAULT_MODELS["local-webgpu"],
          inputTokens: estimateTokens(promptChars(messages)),
          outputTokens: estimateTokens(text),
          estimated: true,
        });
        return text;
      } finally {
        off();
      }
    }
    toast.warn(t("ai.toast.localUnavailable.title"), t("ai.toast.localUnavailable.body"), docsUrl("localLlm"));
    assertCloudFallback("Local WebGPU AI");
    localFirst = null;
  }

  // ── Anthropic Claude (cloud) ───────────────────────────────────
  if (provider === "anthropic" && !localFirst) {
    const { chatAnthropic } = await import("./anthropicProvider");
    assertCloudProvider("anthropic");
    getProviderKey("anthropic"); // NO_KEY before anything is charged
    checkRateLimit();
    charge();
    inflight++;
    try {
      return await chatAnthropic(messages, opts);
    } finally {
      inflight--;
    }
  }

  // ── Google Gemini (cloud) ──────────────────────────────────────
  if (provider === "gemini" && !localFirst) {
    const { chatGemini } = await import("./geminiProvider");
    assertCloudProvider("gemini");
    getProviderKey("gemini"); // NO_KEY before anything is charged
    checkRateLimit();
    charge();
    inflight++;
    try {
      return await chatGemini(messages, opts);
    } finally {
      inflight--;
    }
  }

  // ── Mistral (cloud, OpenAI-compatible) ─────────────────────────
  if (provider === "mistral" && !localFirst) {
    const { chatMistral } = await import("./mistralProvider");
    assertCloudProvider("mistral");
    getProviderKey("mistral"); // NO_KEY before anything is charged
    checkRateLimit();
    charge();
    inflight++;
    try {
      return await chatMistral(messages, opts);
    } finally {
      inflight--;
    }
  }

  // ── OpenAI (cloud) ─────────────────────────────────────────────
  // Also the fallback when Ollama / WebGPU isn't available (never under
  // `local-only`: the fallbacks above stop first).
  assertCloudProvider("openai");
  const key = getAiKey();
  checkRateLimit();
  charge();
  inflight++;
  // F3 — when the user has trained + enabled their personal model,
  // route chat() through it. Caller-supplied `opts.model` still wins
  // so individual call sites (e.g. autocomplete) can pin a fast model.
  const storeState = useAppStore.getState();
  const fineTuneOverride =
    storeState.useFineTunedModel && storeState.fineTunedModelId
      ? storeState.fineTunedModelId
      : null;
  const model = opts.model ?? fineTuneOverride ?? DEFAULT_MODEL;
  opts.onRoute?.("openai", model);

  try {
    const res = await fetchWithRetry(
      API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        }),
        signal: opts.signal,
      },
      { label: "llm.chat", maxRetries: MAX_RETRIES, baseDelayMs: 500, maxDelayMs: 2000 },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AiError("API_ERROR", `API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    // Metered even when the answer turns out empty (it was billed).
    reportOpenAiUsage(data.usage, data.model ?? model, opts);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AiError("PARSE_ERROR", "Empty AI response.");
    return text;
  } catch (err) {
    if (opts.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      return "";
    }
    throw err;
  } finally {
    inflight--;
  }
}

/**
 * Stream a chat completion. Yields text chunks as they arrive.
 * Routes through the active provider (Ollama / OpenAI / WebGPU).
 */
/** OpenAI-shaped `usage` (OpenAI, Mistral) → the usage meter. */
export function reportOpenAiUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined,
  model: string,
  opts: ChatOptions,
  provider = "openai",
): void {
  if (!usage || typeof usage.prompt_tokens !== "number") return;
  // OpenAI caches long prompt prefixes automatically (billed at a discount).
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  opts.onUsage?.({
    provider,
    model,
    inputTokens: usage.prompt_tokens - cached,
    outputTokens: usage.completion_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
  });
}

/**
 * Stream a chat completion. Yields text chunks as they arrive. Usage is
 * recorded when the stream ends (exact when the provider reports it).
 */
export async function* chatStream(
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string, void, undefined> {
  const provider = getActiveProvider();
  const opts = await routed(provider, options);
  let reported = false;
  let out = "";
  let routedTo: AiProvider = provider;
  let sentModel = effectiveModel(provider, opts);
  try {
    for await (const chunk of chatStreamDirect(messages, {
      ...opts,
      onRoute: (p, m) => {
        routedTo = p;
        sentModel = m;
      },
      onUsage: (u) => {
        reported = true;
        recordUsage({ ...u, provider: u.provider ?? provider });
      },
    })) {
      out += chunk;
      yield chunk;
    }
  } finally {
    // Also on abort, a read error or the consumer stopping early: the
    // final usage event never arrived, but the generated text was billed.
    if (out && !reported) {
      recordUsage({
        provider: routedTo,
        model: sentModel,
        inputTokens: estimateTokens(promptChars(messages)),
        outputTokens: estimateTokens(out),
        estimated: true,
      });
    }
  }
}

async function* chatStreamDirect(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string, void, undefined> {
  const charge = () => {
    if (opts.chargeHook) return opts.chargeHook();
    if (opts.prepaid) return;
    if (opts.ownPrompt) {
      if (!consumeAiPrompt(new Date(), { silent: opts.ownPrompt === "silent" })) {
        throw new AiQuotaExceededError(aiQuotaStatus(new Date()).limit);
      }
      return;
    }
    chargeAiCommandDispatch();
  };
  const provider = getActiveProvider();
  if (!opts.prepaid && !opts.chargeHook && !aiQuotaStatus(new Date()).allowed) charge();
  let localFirst = await localRoute(provider);

  if (provider === "ollama" || localFirst === "ollama") {
    const { chatOllamaStream, isOllamaAvailable, getBaseUrl } = await import("./ollamaProvider");
    assertOllamaOrigin(getBaseUrl());
    if (await isOllamaAvailable()) {
      charge();
      const local = forLocal(opts);
      opts.onRoute?.("ollama", effectiveModel("ollama", local));
      yield* chatOllamaStream(messages, local);
      return;
    }
    if (localFirst === "ollama") localFirst = await localRoute(provider);
    // As in chat(): with Privacy Mode on, the in-browser model below may
    // still answer; only without it is the cloud fallback checked here.
    else if (!useAppStore.getState().useLocalAi) assertCloudFallback("Ollama");
  }

  // ── WebGPU local (in-browser), streaming ───────────────────────
  if (provider === "local-webgpu" || localFirst === "local-webgpu" || (!isCloudProvider(provider) && useAppStore.getState().useLocalAi)) {
    const { chatLocalStream, localLlmAvailable, onLocalLlmProgress, defaultLocalModel } = await import("./localLlm");
    if (localLlmAvailable().available) {
      let lastPct = -1;
      const off = onLocalLlmProgress(({ progress, text }) => {
        const pct = Math.round(progress * 100);
        if (pct >= lastPct + 5 || pct === 100) {
          lastPct = pct;
          toast.info(t("ai.toast.localLoading.title"), t("ai.toast.localLoading.body", { pct, status: text || t("ai.toast.localLoading.preparing") }));
        }
      });
      try {
        charge();
        const model = forLocal(opts).model ?? (await defaultLocalModel());
        opts.onRoute?.("local-webgpu", model);
        yield* chatLocalStream(messages, { model, maxTokens: opts.maxTokens, temperature: opts.temperature, signal: opts.signal });
        return;
      } finally {
        off();
      }
    }
    toast.warn(t("ai.toast.localUnavailable.title"), t("ai.toast.localUnavailable.body"), docsUrl("localLlm"));
    assertCloudFallback("Local WebGPU AI");
    localFirst = null;
  }

  if (provider === "anthropic" && !localFirst) {
    const { chatAnthropicStream } = await import("./anthropicProvider");
    assertCloudProvider("anthropic");
    getProviderKey("anthropic"); // NO_KEY before anything is charged
    charge();
    yield* chatAnthropicStream(messages, opts);
    return;
  }

  if (provider === "gemini" && !localFirst) {
    const { chatGeminiStream } = await import("./geminiProvider");
    assertCloudProvider("gemini");
    getProviderKey("gemini"); // NO_KEY before anything is charged
    charge();
    yield* chatGeminiStream(messages, opts);
    return;
  }

  if (provider === "mistral" && !localFirst) {
    const { chatMistralStream } = await import("./mistralProvider");
    assertCloudProvider("mistral");
    getProviderKey("mistral"); // NO_KEY before anything is charged
    charge();
    yield* chatMistralStream(messages, opts);
    return;
  }

  // OpenAI — also the fallback when Ollama isn't available.
  assertCloudProvider("openai");
  const key = getAiKey();
  checkRateLimit();
  charge();
  inflight++;
  const model = opts.model ?? DEFAULT_MODEL;
  opts.onRoute?.("openai", model);

  try {
    const res = await fetchWithRetry(
      API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          // The last chunk then carries `usage` (empty `choices`).
          stream_options: { include_usage: true },
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }),
        signal: opts.signal,
      },
      { label: "llm.chatStream", maxRetries: MAX_RETRIES, baseDelayMs: 500, maxDelayMs: 2000 },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AiError("API_ERROR", `API ${res.status}: ${body.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new AiError("API_ERROR", "No response body.");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          if (json.usage) reportOpenAiUsage(json.usage, json.model ?? model, opts);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return;
    }
    throw err;
  } finally {
    inflight--;
  }
}

/**
 * Parse a JSON response from the AI, stripping any markdown code fences.
 */
export function parseJsonResponse<T = unknown>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new AiError("PARSE_ERROR", "Failed to parse AI JSON response.");
  }
}
