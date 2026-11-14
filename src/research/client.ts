/**
 * Client for the research worker (edge-workers/research): page extraction
 * and search with the user's own key. The endpoint comes from the build
 * (VITE_RESEARCH_ENDPOINT, added to the CSP) or a runtime override that
 * the CSP must already allow.
 */
import { connectAllowedByCsp } from "../lib/cspConnect";
import { getSecret, setSecret } from "../lib/secretStore";

export interface ExtractedPage {
  url: string;
  finalUrl: string;
  /** HTTP status of the final response; 0 when it wasn't fetched. */
  status: number;
  title?: string;
  text?: string;
  truncated?: boolean;
  /** blocked-url | http-error | unsupported-type | too-many-redirects | network */
  error?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = "claude" | "brave" | "tavily" | "searxng";

/** Providers that run behind the research service and need no API key. */
export const KEYLESS_PROVIDERS: readonly SearchProvider[] = ["searxng"];

export interface ResearchSettings {
  provider: SearchProvider;
  key: string;
}

const ls = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/** A research-service address this deployment can actually reach (http(s) and allowed by the CSP). */
export function usableResearchEndpoint(url: string): string | null {
  const clean = url.trim().replace(/\/+$/, "");
  try {
    const u = new URL(clean);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return connectAllowedByCsp(clean) ? clean : null;
}

export function researchEndpoint(): string | null {
  const built = (import.meta.env?.VITE_RESEARCH_ENDPOINT as string | undefined)?.trim();
  const override = ls("lumen.research.endpoint")?.trim();
  const url = override || built;
  if (!url) return null;
  return connectAllowedByCsp(url) ? url.replace(/\/+$/, "") : null;
}

/** Secret-store name of the research worker's shared token (AI settings → research service token). */
export const RESEARCH_SERVICE_TOKEN = "lumen.research.serviceToken";
/** The endpoint that token was saved for (not secret): it is sent only there. */
const TOKEN_ENDPOINT_KEY = "lumen.research.tokenEndpoint";
const builtEndpoint = () => (import.meta.env?.VITE_RESEARCH_ENDPOINT as string | undefined)?.trim() ?? "";
const sameEndpoint = (a: string, b: string) => !!a && a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/**
 * The shared token the research worker requires (its RESEARCH_TOKEN, A8)
 * for a request to `endpoint` (default: the one in use — the settings
 * override, else the build's). The user enters it in AI settings and it
 * lives in the secret store; it is never a build variable, because every
 * VITE_* value ships in the bundle. A token saved for one endpoint goes only
 * to that endpoint — never to another service. One saved before tokens were
 * bound to an endpoint has no record and is sent as before.
 */
export function researchToken(endpoint?: string | null, built = builtEndpoint()): string {
  const saved = getSecret(RESEARCH_SERVICE_TOKEN)?.trim() ?? "";
  if (!saved) return "";
  const boundTo = ls(TOKEN_ENDPOINT_KEY);
  if (!boundTo) return saved;
  const target = endpoint ?? (ls("lumen.research.endpoint")?.trim() || built);
  return sameEndpoint(boundTo, target) ? saved : "";
}

/**
 * Save the AI-settings token for the endpoint now in use. A token left
 * unchanged while the endpoint changed is dropped instead of being moved
 * to the new service. Returns the token now kept ("" when none).
 */
export function saveResearchToken(token: string, edited: boolean, built = builtEndpoint()): string {
  const active = ls("lumen.research.endpoint")?.trim() || built;
  let keep = token.trim();
  const boundTo = ls(TOKEN_ENDPOINT_KEY);
  if (!edited && keep && boundTo && !sameEndpoint(boundTo, active)) keep = "";
  void setSecret(RESEARCH_SERVICE_TOKEN, keep || null);
  try {
    if (keep && active) localStorage.setItem(TOKEN_ENDPOINT_KEY, active.replace(/\/+$/, ""));
    else localStorage.removeItem(TOKEN_ENDPOINT_KEY);
  } catch {
    /* why: storage denied */
  }
  return keep;
}

/**
 * Headers for a research-service request to `endpoint`: the shared token the
 * worker requires (see the worker README), when one is configured for it.
 * Sent only when configured, so a plain GET stays a simple CORS request.
 */
function serviceHeaders(endpoint: string, extra: Record<string, string> = {}): Record<string, string> {
  const token = researchToken(endpoint);
  return token ? { ...extra, "X-Lumen-Research-Token": token } : extra;
}

export function getResearchSettings(): ResearchSettings {
  const p = ls("lumen.research.provider");
  let provider: SearchProvider;
  if (p === "brave" || p === "tavily" || p === "searxng" || p === "claude") provider = p;
  else {
    // Nothing chosen yet: under the local-only policy Claude web search is
    // not allowed, so the default is the keyless self-hosted SearXNG route.
    let policy: string | null = null;
    try {
      policy = localStorage.getItem("lumen.ai.policy");
    } catch {
      policy = null;
    }
    // An explicit local-only choice wins over a leftover Anthropic key.
    const cloudy = policy === "cloud" || policy === "local-first" || (policy !== "local-only" && !!getSecret("lumen.ai.key.anthropic"));
    provider = cloudy ? "claude" : "searxng";
  }
  return { provider, key: getSecret("lumen.research.searchKey") ?? "" };
}

export function setResearchSettings(s: Partial<ResearchSettings>): void {
  try {
    if (s.provider) localStorage.setItem("lumen.research.provider", s.provider);
    if (s.key !== undefined) {
      setSecret("lumen.research.searchKey", s.key || null);
    }
  } catch {
    /* why: storage denied: the settings last for this session only */
  }
}

export class ResearchUnavailableError extends Error {
  constructor(message = "The research service isn't configured for this deployment (VITE_RESEARCH_ENDPOINT).") {
    super(message);
    this.name = "ResearchUnavailableError";
  }
}

/**
 * `fetchImpl`: the agent network tools pass the fetch their policy /
 * consent gate opened (recorded in the privacy ledger); everyone else uses
 * the page's fetch, which the ledger wraps at startup.
 */
export async function extractPage(url: string, signal?: AbortSignal, endpoint = researchEndpoint(), fetchImpl: typeof fetch = (i, o) => fetch(i, o)): Promise<ExtractedPage> {
  if (!endpoint) throw new ResearchUnavailableError();
  try {
    const res = await fetchImpl(`${endpoint}/extract?url=${encodeURIComponent(url)}`, { signal, headers: serviceHeaders(endpoint) });
    const body = (await res.json().catch(() => ({}))) as Partial<ExtractedPage> & { error?: string };
    if (!res.ok && !body.status) return { url, finalUrl: url, status: 0, error: body.error ?? `service ${res.status}` };
    return { url, finalUrl: body.finalUrl ?? url, status: body.status ?? res.status, ...body } as ExtractedPage;
  } catch (e) {
    if (signal?.aborted) throw e;
    return { url, finalUrl: url, status: 0, error: "network" };
  }
}

export async function searchWeb(
  query: string,
  settings: ResearchSettings,
  count = 5,
  signal?: AbortSignal,
  endpoint = researchEndpoint(),
  fetchImpl: typeof fetch = (i, o) => fetch(i, o),
): Promise<SearchHit[]> {
  if (!endpoint) throw new ResearchUnavailableError();
  if (settings.provider === "claude") throw new Error("Claude web search runs through the Anthropic API, not the research service.");
  if (!settings.key && !KEYLESS_PROVIDERS.includes(settings.provider)) throw new Error(`Add your ${settings.provider} API key (Research: Settings…).`);
  const res = await fetchImpl(`${endpoint}/search`, {
    method: "POST",
    headers: serviceHeaders(endpoint, { "Content-Type": "application/json" }),
    // A keyless provider (SearXNG) never gets the key: one saved for Brave /
    // Tavily stays in the store after a switch, and the consent prompt for a
    // keyless search promises that only the query is sent.
    body: JSON.stringify(KEYLESS_PROVIDERS.includes(settings.provider) ? { provider: settings.provider, query, count } : { provider: settings.provider, query, key: settings.key, count }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { results?: SearchHit[]; error?: string };
  if (!res.ok) throw new Error(`Search failed: ${body.error ?? res.status}`);
  return body.results ?? [];
}
