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

/** Secret-store name of the research service token set in the AI settings. */
const RESEARCH_TOKEN_SECRET = "lumen.research.token";
/** The endpoint that token was saved for (not secret): it is sent only there. */
const TOKEN_ENDPOINT_KEY = "lumen.research.tokenEndpoint";
const builtEndpoint = () => (import.meta.env?.VITE_RESEARCH_ENDPOINT as string | undefined)?.trim() ?? "";
const builtToken = () => (import.meta.env?.VITE_RESEARCH_TOKEN as string | undefined)?.trim() ?? "";
const sameEndpoint = (a: string, b: string) => !!a && a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/**
 * The shared token the research worker requires (its RESEARCH_TOKEN, A8)
 * for the endpoint in use (the settings override, else the build's). A
 * token saved in the AI settings goes only to the endpoint it was saved
 * for; otherwise the build's endpoint gets VITE_RESEARCH_TOKEN, and any
 * other endpoint gets none — a token is never sent to another service.
 */
export function researchToken(build = builtToken(), built = builtEndpoint()): string {
  const override = ls("lumen.research.endpoint")?.trim() ?? "";
  const active = override || built;
  const saved = getSecret(RESEARCH_TOKEN_SECRET)?.trim() ?? "";
  if (saved && sameEndpoint(ls(TOKEN_ENDPOINT_KEY) ?? "", active)) return saved;
  return sameEndpoint(built, active) ? build : "";
}

/**
 * Save the AI-settings token for the endpoint now in use. A token left
 * unchanged while the endpoint changed is dropped instead of being moved
 * to the new service. Returns the token now kept ("" when none).
 */
export function saveResearchToken(token: string, edited: boolean, built = builtEndpoint()): string {
  const active = ls("lumen.research.endpoint")?.trim() || built;
  let keep = token.trim();
  if (!edited && keep && !sameEndpoint(ls(TOKEN_ENDPOINT_KEY) ?? "", active)) keep = "";
  void setSecret(RESEARCH_TOKEN_SECRET, keep || null);
  try {
    if (keep && active) localStorage.setItem(TOKEN_ENDPOINT_KEY, active.replace(/\/+$/, ""));
    else localStorage.removeItem(TOKEN_ENDPOINT_KEY);
  } catch {
    /* storage denied */
  }
  return keep;
}

/** Headers for research-service requests, with the token when one is configured. */
function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = researchToken();
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
    /* */
  }
}

export class ResearchUnavailableError extends Error {
  constructor(message = "The research service isn't configured for this deployment (VITE_RESEARCH_ENDPOINT).") {
    super(message);
    this.name = "ResearchUnavailableError";
  }
}

export async function extractPage(url: string, signal?: AbortSignal, endpoint = researchEndpoint()): Promise<ExtractedPage> {
  if (!endpoint) throw new ResearchUnavailableError();
  try {
    const res = await fetch(`${endpoint}/extract?url=${encodeURIComponent(url)}`, { signal, headers: serviceHeaders() });
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
): Promise<SearchHit[]> {
  if (!endpoint) throw new ResearchUnavailableError();
  if (settings.provider === "claude") throw new Error("Claude web search runs through the Anthropic API, not the research service.");
  if (!settings.key && !KEYLESS_PROVIDERS.includes(settings.provider)) throw new Error(`Add your ${settings.provider} API key (Research: Settings…).`);
  const res = await fetch(`${endpoint}/search`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ provider: settings.provider, query, key: settings.key, count }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { results?: SearchHit[]; error?: string };
  if (!res.ok) throw new Error(`Search failed: ${body.error ?? res.status}`);
  return body.results ?? [];
}
