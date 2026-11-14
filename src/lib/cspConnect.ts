/**
 * Can the page `fetch()` this URL under its Content-Security-Policy?
 *
 * Lumen ships a strict `connect-src` (listed origins, plus the
 * deployment's own endpoints added at build time — see
 * src/build/cspEndpoints.ts). Endpoints a user overrides at RUNTIME
 * (localStorage: marketplace backend, Ollama host, …) are only reachable
 * when their origin is in that list; otherwise the browser blocks the
 * request before it leaves. Callers use this to ignore such an override
 * with a clear message instead of failing silently.
 *
 * Reads the policy from the `<meta http-equiv="Content-Security-Policy">`
 * that index.html carries (the same policy the headers send). With no meta
 * policy (tests, embeds) everything is allowed.
 */

function connectSources(): string[] | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const csp = meta?.getAttribute("content");
  if (!csp) return null;
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => /^connect-src\s/i.test(d) || /^default-src\s/i.test(d) && !/connect-src/i.test(csp));
  if (!directive) return null;
  return directive.split(/\s+/).slice(1);
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return pattern === host;
}

/**
 * CSP3 'self': the page's origin, plus the secure / WebSocket schemes on the
 * same host and port (http page → https, ws, wss; https page → wss).
 */
function selfMatches(u: URL, page: { origin: string; protocol: string; host: string }): boolean {
  if (u.origin === page.origin) return true;
  if (u.host !== page.host) return false;
  if (page.protocol === "http:") return u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:";
  if (page.protocol === "https:") return u.protocol === "wss:";
  return false;
}

/** True for a URL whose host is an IPv6 literal, which no CSP source can name. */
export function isIpv6LiteralUrl(url: string): boolean {
  try {
    return new URL(url).hostname.startsWith("[");
  } catch {
    return false;
  }
}

export function connectAllowedByCsp(url: string, sources: string[] | null = connectSources()): boolean {
  if (!sources) return true;
  let u: URL;
  try {
    u = new URL(url, typeof location !== "undefined" ? location.href : undefined);
  } catch {
    return false;
  }
  for (const raw of sources) {
    const src = raw.replace(/^'|'$/g, "");
    if (src === "*") return true;
    if (src === "self") {
      if (typeof location !== "undefined" && selfMatches(u, location)) return true;
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) {
      if (u.protocol === src.toLowerCase()) return true;
      continue;
    }
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\[[^\]]*\]|[^/:[\]]+)(?::(\d+|\*))?(?:\/|$)/i.exec(src);
    if (!m) continue;
    // A bracketed IPv6 literal (`ws://[::1]:4444`) is not a host-source in
    // CSP3, and browsers ignore it (Chromium: "contains an invalid source …
    // It will be ignored"), so it allows nothing. Treating it as a match
    // would hand a caller a server the browser then blocks. The build skips
    // such origins with a warning (src/build/cspEndpoints.ts).
    if (m[2].startsWith("[")) continue;
    const [, scheme, host, port] = m;
    if (scheme && `${scheme.toLowerCase()}:` !== u.protocol) continue;
    if (!hostMatches(host.toLowerCase(), u.hostname.toLowerCase())) continue;
    const defPort = u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80";
    if (port && port !== "*" && port !== (u.port || defPort)) continue;
    if (!port && u.port && u.port !== defPort) continue;
    return true;
  }
  return false;
}
