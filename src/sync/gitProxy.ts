/**
 * Git over HTTP from a browser needs a CORS proxy: GitHub, GitLab and most
 * hosts do not send CORS headers on the smart-HTTP endpoints (plan 3.3).
 *
 * Lumen ships no default proxy host. The proxy is, in order:
 *   1. what the user set (⌘K → "Git: set CORS proxy…", kept in localStorage);
 *   2. the deployment's build setting `VITE_GIT_CORS_PROXY`;
 *   3. none — requests go to the git host directly (works for hosts that
 *      allow CORS, a same-origin git server, or the desktop app).
 *
 * Run one locally with `docker compose -f docker/git-proxy.yml up -d`
 * (http://localhost:9999), or host @isomorphic-git/cors-proxy yourself.
 * See docs/src/content/docs/sync/git.md.
 */

const KEY = "lumen.git.corsProxy.v1";

/** The local proxy from docker/git-proxy.yml (allowed by the CSP). */
export const LOCAL_GIT_PROXY = "http://localhost:9999";

/** A usable proxy URL (http/https, no query or fragment), normalised without a trailing slash; null otherwise. */
export function normaliseProxyUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return u.href.replace(/\/+$/, "");
}

/** Which proxy applies: the user's setting, else the build's, else none. */
export function resolveCorsProxy(stored: string | null | undefined, built: string | null | undefined): string | undefined {
  return normaliseProxyUrl(stored) ?? normaliseProxyUrl(built) ?? undefined;
}

function builtProxy(): string | undefined {
  return (import.meta.env?.VITE_GIT_CORS_PROXY as string | undefined)?.trim() || undefined;
}

/** The setting for this page when localStorage refuses it (private mode, embeds). */
let memory: string | null | undefined;

export function getStoredCorsProxy(): string | null {
  if (memory !== undefined) return memory;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Save the user's proxy ("" or null clears it). Throws on a value that is not an http(s) URL. */
export function setStoredCorsProxy(value: string | null): void {
  const v = value?.trim() ?? "";
  if (v && !normaliseProxyUrl(v)) throw new Error(`Not a proxy URL: ${v}`);
  const stored = v ? normaliseProxyUrl(v)! : null;
  try {
    if (stored) localStorage.setItem(KEY, stored);
    else localStorage.removeItem(KEY);
    memory = undefined;
  } catch {
    // Storage refused (private mode, embeds): the setting lasts for this page.
    memory = stored;
  }
}

/** The proxy git requests go through now (undefined: direct). */
export function getCorsProxy(): string | undefined {
  return resolveCorsProxy(getStoredCorsProxy(), builtProxy());
}

/**
 * isomorphic-git's `onAuth`: a token when one is saved, otherwise nothing —
 * so a public repository clones and pulls without one.
 */
export function authFor(token: string | null | undefined): { onAuth?: () => { username: string; password: string } } {
  return token ? { onAuth: () => ({ username: token, password: "x-oauth-basic" }) } : {};
}

/** Did this fail because the request never got through (CORS, network), rather than a git error? */
export function looksLikeCorsFailure(err: unknown): boolean {
  const e = err as { name?: string; message?: string; code?: string } | null;
  if (!e) return false;
  if (e.code === "HttpError" || e.code === "NotFoundError" || e.code === "MergeNotSupportedError") return false;
  return e.name === "TypeError" && /fetch|network|load failed/i.test(e.message ?? "");
}
