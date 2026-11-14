/**
 * Can an AI request actually be dispatched right now? Mirrors chat()'s
 * routing in ./llm.ts without importing it, so the quota gate can call it
 * before spending a prompt — a request that will immediately fail with
 * "configure your key" must not consume the user's monthly allowance.
 *
 *  - anthropic / gemini / mistral need their own key (lumen.ai.key.<id>);
 *  - ollama is a local server: assumed reachable (chat() falls back to
 *    OpenAI with a toast if it isn't, which is still a dispatched request);
 *  - local WebGPU (provider or the useLocalAi toggle) needs navigator.gpu;
 *  - everything else ends at OpenAI, which needs the stored AI key;
 *  - a cloud provider counts only when the AI policy (./policy.ts) lets
 *    the request reach it.
 */
import { useAppStore } from "../store/useStore";
import { cloudAllowed, getAiPolicy, isCloudProvider, isLocalOrigin, providerAllowed } from "./policy";
import { getBaseUrl, ollamaKnownAvailable } from "./ollamaProvider";
import { getSecret } from "../lib/secretStore";

const KEYED_PROVIDERS = new Set(["anthropic", "gemini", "mistral"]);

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * With a cloud provider selected under a local policy, chat() reroutes to a
 * local backend when one is there (localRoute): a local-origin Ollama that a
 * probe has actually seen, or WebGPU when opted in / local-only.
 */
function localRouteLikely(state: { useLocalAi: boolean }): boolean {
  const policy = getAiPolicy();
  if (policy === "cloud") return false;
  if (isLocalOrigin(getBaseUrl()) && ollamaKnownAvailable()) return true;
  return (policy === "local-only" || state.useLocalAi) && hasWebGpu();
}

export function hasAiCredentials(): boolean {
  const provider = read("lumen.ai.provider");
  const state = useAppStore.getState();
  if (KEYED_PROVIDERS.has(provider)) {
    if (localRouteLikely(state)) return true;
    return providerAllowed(provider) && Boolean(getSecret(`lumen.ai.key.${provider}`));
  }
  if (provider === "ollama") return getAiPolicy() !== "local-only" || isLocalOrigin(getBaseUrl());
  if ((provider === "local-webgpu" || state.useLocalAi) && hasWebGpu()) return true;
  // The OpenAI default: a cloud provider like the keyed ones.
  if ((provider === "openai" || !provider) && isCloudProvider(provider || "openai") && localRouteLikely(state)) return true;
  return cloudAllowed() && Boolean(state.aiKey);
}
