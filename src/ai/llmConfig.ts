/**
 * The LLM service's types and provider settings (split out of llm.ts, plan
 * W4.11; llm.ts re-exports every name, so importers and mocks of "./llm" are
 * unchanged): messages and options, the active provider and its key, the
 * model each provider uses, and AiError. No request is sent from here.
 */
import { useAppStore } from "../store/useStore";
import { type Usage } from "./usage";
import { getSecret } from "../lib/secretStore";
import { getOllamaConfigModel } from "./ollamaProvider";

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

export const DEFAULT_MODEL = "gpt-4o-mini";
/** Each cloud provider's model when the user hasn't picked one (the provider modules use these). */
export const PROVIDER_DEFAULT_MODELS = {
  // The in-browser default when the user picked none and the GPU wasn't
  // probed yet; the model manager (./modelManager.ts) picks by hardware.
  "local-webgpu": "Qwen3-4B-q4f16_1-MLC",
  // Sonnet 4.5 is deprecated (retires 30 Nov 2026); Sonnet 5.5 is the current general model.
  anthropic: "claude-sonnet-5-5",
  // Gemini 1.5 and 2.0 are shut down; 2.5 is closed to new users (Google AI models page, 10/2026).
  gemini: "gemini-3.8-flash",
  mistral: "mistral-small-latest",
} as const;

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
  } catch { /* why: storage denied: fall back to the default provider below */ }
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
  } catch { /* why: secret store unavailable: fall through to the store key and then the missing-key error */ }
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
    const saved = localStorage.getItem(`lumen.ai.model.${provider}`);
    if (provider === "gemini" && saved && isRetiredGeminiModel(saved)) return fallback;
    return saved || fallback;
  } catch {
    return "default";
  }
}

/** Each cloud provider's small, cheap model for light tasks. */
export const LIGHT_MODELS: Partial<Record<AiProvider, string>> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-5-5",
  gemini: "gemini-3.5-flash-lite",
  mistral: "mistral-small-latest",
};

/**
 * Gemini models Google has shut down. A saved choice of one of these is
 * ignored in favour of the current default, so old settings keep working.
 */
export function isRetiredGeminiModel(model: string): boolean {
  return /^gemini-(1\.|2\.0)/i.test(model);
}

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
