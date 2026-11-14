/**
 * WorkOS SSO provider (ε.1 / F4).
 *
 * Wraps WorkOS's SAML / OIDC authorization-code dance through the
 * Lumen edge worker (`edge-workers/auth/`):
 *
 *   1. `signInWithSso(domain)` → POST `/api/sso/authorize` with the
 *      org domain → worker returns `{ redirect }` → browser navigates
 *      to the IdP.
 *   2. After the IdP roundtrip, the IdP posts back to the worker's
 *      `/api/sso/callback?code=…`. The worker exchanges the code for
 *      a profile, signs a Lumen session JWT, and 302-redirects to
 *      `${origin}/?sso=ok`.
 *   3. `loadSession()` reads the cookie (or `?sso=ok` flash param)
 *      and returns the resulting `User`.
 *
 *   4. `getAccessToken()` fetches a short-lived bearer token from
 *      `/api/sso/token` (the session cookie is HttpOnly) so other
 *      services — the billing worker's `/entitlements` — can identify
 *      the SSO user.
 *
 * This module is the **client surface only**. The edge worker that
 * holds the WorkOS API key is in `edge-workers/auth/worker.ts`.
 */

import type { AuthProvider, User } from "./types";
import { fetchWithRetry } from "../lib/fetchRetry";
import { log } from "../lib/logger";

interface WorkOSConfig {
  /** Edge worker base URL, e.g. `https://auth.lumen.md`. */
  endpoint: string;
}

function readEndpoint(): string | null {
  try {
    const url = import.meta.env.VITE_WORKOS_ENDPOINT as string | undefined;
    return url && url.length > 0 ? url.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

let testOverride: WorkOSConfig | null = null;
/** Test-only hook — skips the env read so tests can drive the provider. */
export function __setWorkOSConfigForTesting(cfg: WorkOSConfig | null): void {
  testOverride = cfg;
  cachedToken = null;
}

function readConfig(): WorkOSConfig | null {
  if (testOverride) return testOverride;
  const endpoint = readEndpoint();
  return endpoint ? { endpoint } : null;
}

/**
 * SSO entry point. Resolves to the redirect URL the browser must
 * navigate to. Caller does the actual `location.href = …`.
 */
export async function signInWithSso(domain: string): Promise<string> {
  const cfg = readConfig();
  if (!cfg) throw new Error("WorkOS endpoint not configured (VITE_WORKOS_ENDPOINT)");
  warnIfCrossSite(cfg.endpoint);
  if (!domain.trim()) throw new Error("Org domain required");
  const res = await fetchWithRetry(
    `${cfg.endpoint}/api/sso/authorize?domain=${encodeURIComponent(domain)}`,
    { credentials: "include" },
    { label: "workos.authorize", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 2000 },
  );
  if (!res.ok) {
    throw new Error(`SSO authorize failed: ${res.status}`);
  }
  const json = (await res.json()) as { redirect?: string };
  if (!json.redirect) throw new Error("SSO authorize response missing `redirect`");
  return json.redirect;
}

/**
 * Read the current session from the worker. Returns `null` when the
 * user is anonymous. We rely on a session cookie set by the worker —
 * the browser ships it on every same-site request to the edge.
 */
export async function loadSsoSession(): Promise<User | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  try {
    const res = await fetchWithRetry(
      `${cfg.endpoint}/api/sso/session`,
      {
        credentials: "include",
      },
      { label: "workos.session", maxRetries: 2, baseDelayMs: 800, maxDelayMs: 2500 },
    );
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) return null;
    const json = (await res.json()) as { user?: User };
    return json.user ?? null;
  } catch {
    return null;
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Short-lived bearer token for the billing worker (see the SSO worker's
 * `GET /api/sso/token`). Cached until 30 s before expiry. Returns `null`
 * when not signed in, the worker isn't configured for billing tokens, or
 * it can't be reached — callers then behave as anonymous.
 */
export async function getSsoAccessToken(nowSec = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  if (cachedToken && cachedToken.expiresAt - 30 > nowSec) return cachedToken.token;
  cachedToken = null;
  try {
    const res = await fetchWithRetry(
      `${cfg.endpoint}/api/sso/token`,
      { credentials: "include" },
      { label: "workos.token", maxRetries: 1, baseDelayMs: 500, maxDelayMs: 1500 },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof json.token !== "string" || typeof json.expiresAt !== "number") return null;
    cachedToken = { token: json.token, expiresAt: json.expiresAt };
    return json.token;
  } catch {
    return null;
  }
}

export async function signOutSso(): Promise<void> {
  cachedToken = null;
  const cfg = readConfig();
  if (!cfg) return;
  // The session cookie is HttpOnly and lives up to SESSION_TTL (7 days), so
  // only the worker can end it. If that fails, say so: reporting "signed
  // out" while the cookie survives would silently restore the account on the
  // next load (bad on a shared device).
  const res = await fetchWithRetry(
    `${cfg.endpoint}/api/sso/signout`,
    {
      method: "POST",
      credentials: "include",
    },
    { label: "workos.signout", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 2000 },
  );
  if (!res.ok) throw new Error(`SSO sign-out failed: ${res.status}`);
}

/**
 * Provider record matching the rest of the auth layer's interface.
 * `signInWithProvider` is intentionally NOT implemented — WorkOS
 * does the IdP redirect itself; callers use `signInWithSso(domain)`
 * directly.
 */
export const workosProvider: AuthProvider = {
  name: "workos",
  async loadSession() {
    return loadSsoSession();
  },
  async getAccessToken() {
    return getSsoAccessToken();
  },
  async signOut() {
    await signOutSso();
  },
};

/** Whether WorkOS is available (env var set). */
export function isWorkosEnabled(): boolean {
  return readConfig() !== null;
}

/** Registrable-domain approximation: the last two labels (`a.b.example.org` → `example.org`). */
function siteOf(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":")) return h;
  // workers.dev / pages.dev are public suffixes: each subdomain is its own site.
  if (/\.(workers|pages)\.dev$/.test(h)) return h.split(".").slice(-3).join(".");
  return h.split(".").slice(-2).join(".");
}

/**
 * True when the SSO worker lives on a different site than the app, so its
 * cookies are third-party (blocked by Safari; see DEPLOY.md §5b). Pure —
 * exported for tests.
 */
export function isCrossSiteEndpoint(endpoint: string, appHostname: string): boolean {
  try {
    return siteOf(new URL(endpoint).hostname) !== siteOf(appHostname);
  } catch {
    return false;
  }
}

let warnedCrossSite = false;
function warnIfCrossSite(endpoint: string): void {
  if (warnedCrossSite || typeof location === "undefined") return;
  if (!isCrossSiteEndpoint(endpoint, location.hostname)) return;
  warnedCrossSite = true;
  log.warn(
    `SSO worker ${endpoint} is on a different site than this app: its cookies are third-party and ` +
      "Safari blocks them (sign-in fails with state_mismatch). Serve it from the app's own site — see DEPLOY.md §5b.",
  );
}
