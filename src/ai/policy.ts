/**
 * AI policy — where a request is allowed to go.
 *
 *   local-only   Nothing leaves the machine: Ollama, in-browser WebGPU and
 *                transformers.js only. A cloud provider is never contacted,
 *                not even as a fallback when the local model is unavailable.
 *   local-first  Local executors first; a cloud provider (with the user's
 *                own key) only when none of them can answer.
 *   cloud        The selected cloud provider is used directly.
 *
 * The stored value (`lumen.ai.policy`) wins. Until the user picks one, the
 * default is `local-only` — except for an installation that was already
 * set up for the cloud before policies existed, which keeps the behaviour
 * it had so an upgrade never silently changes where prompts go:
 *   - a cloud provider selected explicitly in `lumen.ai.provider` → `cloud`;
 *   - otherwise a cloud key configured (the old "WebGPU with OpenAI as the
 *     fallback" setup) → `local-first`.
 * The AI settings panel shows the effective policy and lets the user pin it.
 */

import { useAppStore } from "../store/useStore";
import { getSecret } from "../lib/secretStore";

export type AiPolicy = "local-only" | "local-first" | "cloud";

export const AI_POLICIES: readonly AiPolicy[] = ["local-only", "local-first", "cloud"];

const STORAGE_KEY = "lumen.ai.policy";

/** Providers that send prompts to a third party. */
export const CLOUD_PROVIDERS = ["openai", "anthropic", "gemini", "mistral"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export function isCloudProvider(p: string): p is CloudProvider {
  return (CLOUD_PROVIDERS as readonly string[]).includes(p);
}

function storedPolicy(): AiPolicy | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && (AI_POLICIES as readonly string[]).includes(v) ? (v as AiPolicy) : null;
  } catch {
    return null;
  }
}

/** True when the user picked a policy explicitly (not the derived default). */
export function hasExplicitAiPolicy(): boolean {
  return storedPolicy() !== null;
}

/** Any cloud key present — the pre-policy signal that the user opted into the cloud. */
export function hasAnyCloudKey(): boolean {
  try {
    if (useAppStore.getState().aiKey) return true;
  } catch {
    /* why: store not mounted (tests) */
  }
  try {
    return CLOUD_PROVIDERS.some((p) => !!getSecret(`lumen.ai.key.${p}`));
  } catch {
    return false;
  }
}

function cloudProviderSelected(): boolean {
  try {
    const p = localStorage.getItem("lumen.ai.provider");
    return !!p && isCloudProvider(p);
  } catch {
    return false;
  }
}

/** The effective policy: the stored choice, or the compatibility default. */
export function getAiPolicy(): AiPolicy {
  const stored = storedPolicy();
  if (stored) return stored;
  if (cloudProviderSelected()) return "cloud";
  return hasAnyCloudKey() ? "local-first" : "local-only";
}

const policyListeners = new Set<() => void>();

export function setAiPolicy(policy: AiPolicy): void {
  if (!(AI_POLICIES as readonly string[]).includes(policy)) throw new Error(`Unknown AI policy: ${policy}`);
  localStorage.setItem(STORAGE_KEY, policy);
  for (const fn of [...policyListeners]) fn();
}

/**
 * Run `fn` whenever the stored policy may have changed: `setAiPolicy()` in
 * this tab, or a write in another tab (the `storage` event). `fn` reads
 * `getAiPolicy()` itself. Returns the unsubscribe.
 */
export function onAiPolicyChange(fn: () => void): () => void {
  policyListeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) fn(); // null: storage was cleared
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    policyListeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** May a request go to a cloud provider under the current policy? */
export function cloudAllowed(policy: AiPolicy = getAiPolicy()): boolean {
  return policy !== "local-only";
}

/**
 * May content go to a third-party service the user never set up — the public
 * LanguageTool API, the browser's online speech recognition, a server-side
 * read-aloud voice? Only under the `cloud` policy. `local-first` falls back
 * only to the AI provider whose key the user entered; every other service
 * needs the explicit cloud choice (plan 6.17).
 */
export function thirdPartyServicesAllowed(policy: AiPolicy = getAiPolicy()): boolean {
  return policy === "cloud";
}

/**
 * May a request go to `provider` under the current policy? Local providers
 * are always allowed; cloud providers only outside `local-only`.
 */
export function providerAllowed(provider: string, policy: AiPolicy = getAiPolicy()): boolean {
  return !isCloudProvider(provider) || cloudAllowed(policy);
}

/** Thrown by `assertCloudAllowed`: the request was not sent. `code` matches `AiError`. */
export class AiPolicyError extends Error {
  readonly code = "POLICY" as const;
  constructor(message: string) {
    super(message);
    this.name = "AiPolicyError";
  }
}

/**
 * Gate for every path that would send content to a third-party service
 * outside `chat()` — embeddings, transcription, batch jobs, fine-tuning,
 * web research, a public grammar checker. Throws under `local-only`.
 */
export function assertCloudAllowed(what: string, policy: AiPolicy = getAiPolicy()): void {
  if (!cloudAllowed(policy)) {
    throw new AiPolicyError(`AI policy is "local-only": ${what} would send content to a third-party service and was not run.`);
  }
}

/** Loopback, private-network and `.local` origins count as "this machine / this network", not the cloud. */
export function isLocalOrigin(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
