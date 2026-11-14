/**
 * Vercel project configuration (plan 0.20).
 *
 * Vercel runs this file at build time, with the project's environment, in
 * place of a static vercel.json. It loads deploy/vercel.base.json, whose
 * security headers are rendered from security/policy.json and checked by
 * `npm run headers`, and fills the app policy's connect-src placeholder with
 * the origins of the endpoint workers this deployment is built with. A static
 * vercel.json cannot know them, so its header blocked those workers while the
 * page's own <meta> policy allowed them.
 *
 * Self-contained on purpose: no imports beyond Node's, so it runs however
 * Vercel loads it. The endpoint rules mirror src/build/cspEndpoints.ts, and
 * src/__tests__/vercelConfig.test.ts keeps the two in step.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Same list and rules as ENDPOINT_ENV_VARS / endpointOrigins in src/build/cspEndpoints.ts. */
export const ENDPOINT_ENV_VARS = [
  "VITE_WORKOS_ENDPOINT",
  "VITE_BILLING_ENDPOINT",
  "VITE_ENTITLEMENT_ENDPOINT",
  "VITE_PUBLISH_ENDPOINT",
  "VITE_RESEARCH_ENDPOINT",
  "VITE_AUDIT_ENDPOINT",
  "VITE_MARKETPLACE_URL",
  "VITE_LANGUAGETOOL_URL",
  "VITE_SUPABASE_URL",
  // Safe git (plan 3.3): the CORS proxy git requests go through.
  "VITE_GIT_CORS_PROXY",
  // The error tracker (Sentry / GlitchTip, plan 12.4): the DSN's host, never a wildcard.
  "VITE_SENTRY_DSN",
  // Lumen's model mirror (plan W4.14): the CORS proxy in front of the model releases.
  "VITE_MODEL_MIRROR_URL",
  // Plan W4.19: the encrypted vault relay (sync-server/vault-relay.js).
  "VITE_SYNC_RELAY_URL",
];
/** WebSocket URLs (comma-separated) the app opens: collab signaling and the persistent collab server. */
export const WEBSOCKET_ENV_VARS = ["VITE_WEBRTC_SIGNALING_URL", "VITE_YJS_WEBSOCKET_URL"];
export const EXTRA_CONNECT_ENV_VAR = "VITE_CSP_CONNECT_EXTRA";
/** The marker security/policy.json puts in the app policy for this host. */
export const PLACEHOLDER = "__CSP_CONNECT_EXTRA__";

type Env = Record<string, string | undefined>;
interface HeaderEntry {
  source: string;
  headers: { key: string; value: string }[];
}
interface VercelConfig {
  headers?: HeaderEntry[];
  [key: string]: unknown;
}

export function endpointOrigins(env: Env): string[] {
  const out = new Set<string>();
  // A CSP source list cannot name an IPv6 literal (browsers ignore it): skipped, as in cspEndpoints.ts.
  const addOrigin = (url: URL) => {
    if (!url.hostname.startsWith("[")) out.add(url.origin);
  };
  const add = (raw: string, schemes: readonly string[]) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (!schemes.includes(url.protocol)) return;
    if (/(^|\.)example\.(com|org|net)$/i.test(url.hostname) || /placeholder|your-/i.test(raw)) return;
    addOrigin(url);
  };
  for (const key of ENDPOINT_ENV_VARS) {
    const raw = env[key]?.trim();
    if (raw) add(raw, ["https:", "http:"]);
  }
  for (const key of WEBSOCKET_ENV_VARS) {
    for (const raw of (env[key] ?? "").split(",")) if (raw.trim()) add(raw.trim(), ["wss:", "ws:"]);
  }
  for (const raw of (env[EXTRA_CONNECT_ENV_VAR] ?? "").split(/[\s,]+/)) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (["https:", "http:", "wss:", "ws:"].includes(u.protocol)) addOrigin(u);
    } catch {
      /* not an origin: ignore */
    }
  }
  return [...out].sort();
}

/** The base config with the placeholder replaced by `origins` (or removed when there are none). */
export function vercelConfig(base: VercelConfig, origins: readonly string[]): VercelConfig {
  const fill = (value: string) =>
    value
      .split(";")
      .map((part) =>
        part.includes(PLACEHOLDER)
          ? part
              .split(/\s+/)
              .flatMap((t) => (t === PLACEHOLDER ? origins.filter((o) => !part.split(/\s+/).includes(o)) : t ? [t] : []))
              .join(" ")
          : part.trim(),
      )
      .join("; ");
  const { $schema: _schema, ...rest } = base;
  return {
    ...rest,
    headers: (base.headers ?? []).map((entry) => ({
      ...entry,
      headers: entry.headers.map((h) => (h.value.includes(PLACEHOLDER) ? { ...h, value: fill(h.value) } : h)),
    })),
  };
}

const base = JSON.parse(readFileSync(join(process.cwd(), "deploy/vercel.base.json"), "utf8")) as VercelConfig;
export const config = vercelConfig(base, endpointOrigins(process.env));
