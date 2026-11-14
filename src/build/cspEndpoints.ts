/**
 * Build-time CSP extension for deployment-specific endpoints.
 *
 * The checked-in policies (rendered from security/policy.json into
 * index.html <meta>, public/_headers, deploy/vercel.base.json, the nginx configs and
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
  // The error tracker (Sentry / GlitchTip, plan 12.4). Its origin is the
  // DSN's host; the key in the DSN's user part is dropped by URL.origin.
  // No DSN, no ingest host in the policy — never a wildcard.
  "VITE_SENTRY_DSN",
  // Lumen's model mirror (plan W4.14): the CORS proxy in front of the
  // GitHub releases that hold a copy of every model file.
  "VITE_MODEL_MIRROR_URL",
  // Plan W4.19: the encrypted vault relay (sync-server/vault-relay.js).
  "VITE_SYNC_RELAY_URL",
] as const;

/**
 * `VITE_*` variables whose value is a WebSocket URL (or a comma-separated
 * list of them) the app opens: collaboration signaling (y-webrtc) and the
 * persistent collab server (y-websocket), see src/collab/yjs.ts. The
 * policies carry no bare `ws:` / `wss:` (plan 2.2), so a deployment's own
 * collab servers are added here like the HTTP endpoints above.
 */
export const WEBSOCKET_ENV_VARS = ["VITE_WEBRTC_SIGNALING_URL", "VITE_YJS_WEBSOCKET_URL"] as const;

/**
 * Extra connect-src origins a deployment wants to allow (comma/space
 * separated), e.g. a LAN Ollama host or a marketplace backend that users
 * set at runtime. The supported way to reach endpoints not known as
 * VITE_*_ENDPOINT — the policy itself stays an explicit allowlist.
 */
export const EXTRA_CONNECT_ENV_VAR = "VITE_CSP_CONNECT_EXTRA";

/** Placeholder marker in deploy/nginx.conf (+ the runtime include), replaced in the image build. */
export const NGINX_PLACEHOLDER = "__CSP_CONNECT_EXTRA__";

/** File written next to the build output listing the extra origins (one line). */
export const EXTRA_ORIGINS_FILE = ".csp-connect-extra";

/**
 * Origins (scheme://host[:port]) of the configured endpoints, deduplicated
 * and sorted. Empty, placeholder (`example.com`, `your-…`, `…placeholder…`)
 * and non-HTTP(S) values are ignored.
 *
 * An IPv6 literal host (`ws://[::1]:4444`) is skipped and reported through
 * `onSkip`: CSP source lists cannot name one (browsers ignore it as an
 * invalid source), so adding it would allow nothing. Use a hostname.
 */
export function endpointOrigins(
  env: Record<string, string | undefined>,
  onSkip?: (value: string, reason: string) => void,
): string[] {
  const out = new Set<string>();
  const addOrigin = (url: URL, raw: string) => {
    if (url.hostname.startsWith("[")) {
      onSkip?.(raw, "a CSP source list can't name an IPv6 address (browsers ignore it); use a hostname");
      return;
    }
    out.add(url.origin);
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
    addOrigin(url, raw);
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
      if (["https:", "http:", "wss:", "ws:"].includes(u.protocol)) addOrigin(u, raw);
    } catch {
      /* why: not an origin — ignore */
    }
  }
  return [...out].sort();
}

/** Append `origins` to the `connect-src` directive of a CSP string (no duplicates). */
export function addConnectSrc(csp: string, origins: readonly string[]): string {
  return addSources(csp, "connect-src", origins);
}

/**
 * The content frame's own site (plan W6.40, src/lib/contentFrame.ts): the
 * app page must be allowed to frame it. The policy names the official one;
 * this adds another a build is made with (dev and e2e use the other loopback
 * name: http://127.0.0.1:5173/content-frame.html for http://localhost:5173).
 * Only an https: URL, or http: on a loopback host.
 */
export const CONTENT_FRAME_ENV_VAR = "VITE_CONTENT_FRAME_URL";
export function contentFrameOrigins(env: Record<string, string | undefined>): string[] {
  const raw = env[CONTENT_FRAME_ENV_VAR]?.trim();
  if (!raw || raw.includes("#") || raw.includes("?")) return [];
  try {
    const u = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && loopback))) return [];
    return [u.origin];
  } catch {
    return [];
  }
}

/** Append `origins` to the `frame-src` directive of a CSP string (no duplicates). */
export function addFrameSrc(csp: string, origins: readonly string[]): string {
  return addSources(csp, "frame-src", origins);
}

function addSources(csp: string, directive: "connect-src" | "frame-src", origins: readonly string[]): string {
  if (!origins.length) return csp;
  let found = false;
  const parts = csp.split(";").map((part) => {
    const m = part.match(new RegExp(`^(\\s*)${directive}(\\s+)([^]*)$`, "i"));
    if (!m) return part;
    found = true;
    const trailing = m[3].match(/\s*$/)?.[0] ?? "";
    const values = m[3].trim().split(/\s+/).filter(Boolean);
    // A deliberately network-less policy (the live-js runner) stays so:
    // any added source would make the browser ignore 'none'.
    if (values.includes("'none'")) return part;
    // An origin a scheme source already allows adds nothing: the widened first
    // line of Cloudflare's split app policy (security/policy.json
    // hosts.cloudflare.split) stays exactly the superset, and short.
    const covered = (o: string) => /^[a-z]+:\/\//.test(o) && values.includes(o.slice(0, o.indexOf("//")));
    for (const o of origins) if (!values.includes(o) && !covered(o)) values.push(o);
    return `${m[1]}${directive}${m[2]}${values.join(" ")}${trailing}`;
  });
  return found ? parts.join(";") : csp;
}

/** Rewrite the CSP in an index.html `<meta http-equiv="Content-Security-Policy">`. */
export function extendIndexHtmlCsp(html: string, origins: readonly string[], frames: readonly string[] = []): string {
  return html.replace(
    /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)(")/i,
    (_m, a: string, csp: string, b: string) => a + addFrameSrc(addConnectSrc(csp, origins), frames) + b,
  );
}

/**
 * Rewrite the app policy's `Content-Security-Policy:` lines of a
 * Cloudflare/Netlify `_headers` file: those of the catch-all `/*` rule. The
 * other rules (runner pages, OCR and eval workers) keep their own network,
 * as on Vercel and nginx, where only the app policy has the placeholder
 * (security/policy.json; scripts/host-parity.mjs compares the hosts).
 * W6.40: `frames` (the content frame's own site) go into frame-src where the
 * line has one that frames the app itself ('self').
 */
export function extendHeadersFileCsp(text: string, origins: readonly string[], frames: readonly string[] = []): string {
  let rule = "";
  return text
    .split("\n")
    .map((line) => {
      if (/^\S/.test(line) && !line.startsWith("#")) rule = line.trim();
      const m = rule === "/*" ? line.match(/^(\s+Content-Security-Policy:\s*)(.+)$/) : null;
      if (!m) return line;
      const csp = addConnectSrc(m[2], origins);
      return m[1] + (/frame-src\s+'self'/.test(csp) ? addFrameSrc(csp, frames) : csp);
    })
    .join("\n");
}

interface MinimalPlugin {
  name: string;
  configResolved(config: {
    env: Record<string, string | undefined>;
    build: { outDir: string };
    root: string;
    command?: "build" | "serve";
    server?: { port?: number; hmr?: boolean | { port?: number; clientPort?: number } };
    logger?: { warn(msg: string): void };
  }): void;
  transformIndexHtml(html: string): string;
  closeBundle(): Promise<void>;
}

/**
 * The dev server's own WebSocket (Vite HMR), for the page it serves only.
 * CSP3 lets 'self' match ws: on the page's host, but the policies no longer
 * carry a bare ws: (plan 2.2), so the dev page names the HMR port
 * explicitly (any host: `vite --host` is opened by LAN address too). Never
 * part of a build.
 */
export function devServerOrigins(server: { port?: number; hmr?: boolean | { port?: number; clientPort?: number } } = {}): string[] {
  const hmr = typeof server.hmr === "object" ? server.hmr : undefined;
  if (server.hmr === false) return [];
  const port = hmr?.clientPort ?? hmr?.port ?? server.port ?? 5173;
  return [`ws://*:${port}`, `wss://*:${port}`];
}

/**
 * Vite plugin: adds the configured endpoint origins to the <meta> CSP and to
 * `dist/_headers`, and writes them to `dist/.csp-connect-extra` for the
 * nginx image (the Dockerfile substitutes NGINX_PLACEHOLDER).
 */
export function cspEndpointsPlugin(): MinimalPlugin {
  let origins: string[] = [];
  let pageOrigins: string[] = [];
  let frames: string[] = [];
  let outDir = "dist";
  return {
    name: "lumen-csp-endpoints",
    configResolved(config) {
      origins = endpointOrigins({ ...process.env, ...config.env }, (value, reason) =>
        config.logger?.warn(`[lumen-csp-endpoints] not added to connect-src: ${value} (${reason})`),
      );
      pageOrigins = config.command === "serve" ? [...origins, ...devServerOrigins(config.server)] : origins;
      frames = contentFrameOrigins({ ...process.env, ...config.env });
      const path = config.build.outDir;
      outDir = path.startsWith("/") ? path : `${config.root}/${path}`;
    },
    transformIndexHtml(html) {
      return extendIndexHtmlCsp(html, pageOrigins, frames);
    },
    async closeBundle() {
      const fs = await import("node:fs/promises");
      const headers = `${outDir}/_headers`;
      try {
        const text = await fs.readFile(headers, "utf8");
        await fs.writeFile(headers, extendHeadersFileCsp(text, origins, frames));
      } catch {
        /* why: no _headers in this build (e.g. tests) */
      }
      try {
        await fs.writeFile(`${outDir}/${EXTRA_ORIGINS_FILE}`, origins.join(" ") + "\n");
      } catch {
        /* why: outDir missing — nothing was built */
      }
    },
  };
}
