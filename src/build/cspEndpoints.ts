/**
 * Build-time CSP extension for deployment-specific endpoints.
 *
 * The checked-in policies (rendered from security/policy.json into
 * index.html <meta>, public/_headers, vercel.json, the nginx configs and
 * tauri.conf.json by scripts/headers.mjs) list every *public* host the
 * app talks to. The
 * workers a deployment runs itself — SSO, billing/entitlements, publish,
 * audit, marketplace, a self-hosted LanguageTool, Supabase — live on
 * origins only known at build time (`VITE_*` env vars, often
 * `*.workers.dev` or a dedicated subdomain). Browsers enforce every CSP
 * they receive, so those origins must be added to `connect-src` in all of
 * them or the requests are blocked before CORS is even evaluated.
 *
 * This module is build tooling: it is imported by vite.config.ts and tests,
 * never by the app bundle.
 */

/** `VITE_*` variables whose value is an HTTP(S) endpoint the app fetches. */
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
] as const;

/**
 * Extra connect-src origins a deployment wants to allow (comma/space
 * separated), e.g. a LAN Ollama host or a marketplace backend that users
 * set at runtime. The supported way to reach endpoints not known as
 * VITE_*_ENDPOINT — the policy itself stays an explicit allowlist.
 */
export const EXTRA_CONNECT_ENV_VAR = "VITE_CSP_CONNECT_EXTRA";

/** Placeholder marker in docker/nginx.conf, replaced in the image build. */
export const NGINX_PLACEHOLDER = "__CSP_CONNECT_EXTRA__";

/** File written next to the build output listing the extra origins (one line). */
export const EXTRA_ORIGINS_FILE = ".csp-connect-extra";

/**
 * Origins (scheme://host[:port]) of the configured endpoints, deduplicated
 * and sorted. Empty, placeholder (`example.com`, `your-…`, `…placeholder…`)
 * and non-HTTP(S) values are ignored.
 */
export function endpointOrigins(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const key of ENDPOINT_ENV_VARS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (/(^|\.)example\.(com|org|net)$/i.test(url.hostname) || /placeholder|your-/i.test(raw)) continue;
    out.add(url.origin);
  }
  for (const raw of (env[EXTRA_CONNECT_ENV_VAR] ?? "").split(/[\s,]+/)) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (["https:", "http:", "wss:", "ws:"].includes(u.protocol)) out.add(u.origin);
    } catch {
      /* not an origin — ignore */
    }
  }
  return [...out].sort();
}

/** Append `origins` to the `connect-src` directive of a CSP string (no duplicates). */
export function addConnectSrc(csp: string, origins: readonly string[]): string {
  if (!origins.length) return csp;
  let found = false;
  const parts = csp.split(";").map((part) => {
    const m = part.match(/^(\s*)connect-src(\s+)([^]*)$/i);
    if (!m) return part;
    found = true;
    const trailing = m[3].match(/\s*$/)?.[0] ?? "";
    const values = m[3].trim().split(/\s+/).filter(Boolean);
    // A deliberately network-less policy (the live-js runner) stays so:
    // any added source would make the browser ignore 'none'.
    if (values.includes("'none'")) return part;
    for (const o of origins) if (!values.includes(o)) values.push(o);
    return `${m[1]}connect-src${m[2]}${values.join(" ")}${trailing}`;
  });
  return found ? parts.join(";") : csp;
}

/** Rewrite the CSP in an index.html `<meta http-equiv="Content-Security-Policy">`. */
export function extendIndexHtmlCsp(html: string, origins: readonly string[]): string {
  return html.replace(
    /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)(")/i,
    (_m, a: string, csp: string, b: string) => a + addConnectSrc(csp, origins) + b,
  );
}

/** Rewrite every `Content-Security-Policy:` line of a Cloudflare/Netlify `_headers` file. */
export function extendHeadersFileCsp(text: string, origins: readonly string[]): string {
  return text.replace(
    /^(\s*Content-Security-Policy:\s*)(.+)$/gm,
    (_m, a: string, csp: string) => a + addConnectSrc(csp, origins),
  );
}

interface MinimalPlugin {
  name: string;
  configResolved(config: { env: Record<string, string | undefined>; build: { outDir: string }; root: string }): void;
  transformIndexHtml(html: string): string;
  closeBundle(): Promise<void>;
}

/**
 * Vite plugin: adds the configured endpoint origins to the <meta> CSP and to
 * `dist/_headers`, and writes them to `dist/.csp-connect-extra` for the
 * nginx image (docker/Dockerfile.web substitutes NGINX_PLACEHOLDER).
 */
export function cspEndpointsPlugin(): MinimalPlugin {
  let origins: string[] = [];
  let outDir = "dist";
  return {
    name: "lumen-csp-endpoints",
    configResolved(config) {
      origins = endpointOrigins({ ...process.env, ...config.env });
      const path = config.build.outDir;
      outDir = path.startsWith("/") ? path : `${config.root}/${path}`;
    },
    transformIndexHtml(html) {
      return extendIndexHtmlCsp(html, origins);
    },
    async closeBundle() {
      const fs = await import("node:fs/promises");
      const headers = `${outDir}/_headers`;
      try {
        const text = await fs.readFile(headers, "utf8");
        await fs.writeFile(headers, extendHeadersFileCsp(text, origins));
      } catch {
        /* no _headers in this build (e.g. tests) */
      }
      try {
        await fs.writeFile(`${outDir}/${EXTRA_ORIGINS_FILE}`, origins.join(" ") + "\n");
      } catch {
        /* outDir missing — nothing was built */
      }
    },
  };
}
