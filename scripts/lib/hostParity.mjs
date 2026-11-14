/**
 * Plan W6.9: do Vercel and Cloudflare Pages serve the same thing?
 *
 * Emulates each host from its own configuration and compares what a browser
 * gets for a list of probe paths: the status after redirects, the file
 * served, and the security, caching and CORS headers.
 *
 *   Vercel   deploy/vercel.base.json: the filesystem first, then `rewrites`
 *            in order (the SPA fallback), else 404. Every matching `headers`
 *            entry applies, later ones winning (as vercelConfig.test.ts).
 *   Pages    _headers + the asset server of workers-sdk
 *            (packages/pages-shared/asset-server/handler.ts): /x.html and
 *            /x/index.html answer 308 to /x and /x/; a missing file gets the
 *            nearest 404.html up the tree, else index.html with 200 (the SPA
 *            fallback, on only while there is no top-level 404.html). Header
 *            rules: lines of one rule that repeat a name are joined with
 *            ", " (parseHeaders.ts); the first matching rule sets a header,
 *            later ones append; `! Name` removes it; a 404 gets
 *            `Cache-Control: no-store`.
 *
 * A comma-joined CSP is two policies; the comparison uses the policy a
 * browser enforces (combineCspParts in scripts/headers.mjs). Pure: takes the
 * config texts and a file list, so tests and the CLI (scripts/host-parity.mjs)
 * share it. `liveProbe` does the same against two deployed origins.
 */
import { combineCspParts } from "../headers.mjs";

/** Headers compared on every probe. */
export const COMPARED = [
  "content-security-policy",
  "x-frame-options",
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cache-control",
  "access-control-allow-origin",
];

/** What the two hosts default to when no rule sets Cache-Control on a 200 (both documented). */
const DEFAULT_CACHE = "public, max-age=0, must-revalidate";

/** Files the build adds to dist/ besides public/ (hashes as in security/policy.json samples). */
export const BUILT_FILES = [
  "index.html",
  "sw.js",
  "manifest.webmanifest",
  "playground-runner.html",
  "livejs-runner.html",
  "assets/index-AbC123.js",
  "assets/index-AbC123.css",
  "assets/graphviz.worker-AbC123.js",
  "assets/ruby.worker-AbC123.js",
  "assets/tsCheck.worker-AbC123.js",
  "assets/search.worker-AbC123.js",
  "webr/webr-worker.js",
  "tesseract/worker.min.js",
  "playground/vue.esm-browser.js",
];

/** Paths a browser asks for, with what each one stands for. */
export const PROBES = [
  ["/", "the app"],
  ["/index.html", "the app by file name (Pages: 308 to /)"],
  ["/notes/some-doc", "a deep link (SPA fallback)"],
  ["/settings", "a deep link without a dot"],
  ["/sw.js", "the service worker"],
  ["/manifest.webmanifest", "the PWA manifest"],
  ["/assets/index-AbC123.js", "a hashed chunk"],
  ["/assets/index-Gone99.js", "a chunk of the previous deploy (must be 404, not HTML)"],
  ["/assets/graphviz.worker-AbC123.js", "a worker that needs eval"],
  ["/assets/search.worker-AbC123.js", "a worker on the app policy"],
  ["/webr/webr-worker.js", "webR's worker"],
  ["/tesseract/worker.min.js", "the OCR worker"],
  ["/playground-runner.html", "the playground runner (Pages: 308 to /playground-runner)"],
  ["/livejs-runner.html", "the live-js runner (Pages: 308 to /livejs-runner)"],
  ["/content-frame.html", "the content frame for allowed remote media and embeds (Pages: 308 to /content-frame)"],
  ["/playground/vue.esm-browser.js", "a playground vendor file (CORS)"],
  ["/favicon.svg", "a static file"],
  ["/missing-image.png", "a missing top-level file"],
];

/**
 * Differences that are known and accepted, by probe path: Pages has no way to
 * answer 404 outside a folder with its own 404.html without turning the SPA
 * fallback off, and Vercel's rewrite skips every path with an extension.
 */
export const ACCEPTED = {
  "/missing-image.png": "Pages answers a missing top-level file with the app's HTML (200); Vercel with 404. Harmless: no page links such a path, and chunks (the case that matters) live under assets/, which has its own 404.html.",
};

// ───────────────────────────── Vercel ─────────────────────────────

/** deploy/vercel.base.json with the connect-src placeholder filled, as vercel.ts does. */
export function fillVercel(base, origins = [], placeholder = "__CSP_CONNECT_EXTRA__") {
  const fill = (value) =>
    value
      .split(";")
      .map((part) =>
        part.includes(placeholder)
          ? part
              .split(/\s+/)
              .flatMap((t) => (t === placeholder ? origins.filter((o) => !part.split(/\s+/).includes(o)) : t ? [t] : []))
              .join(" ")
          : part.trim(),
      )
      .join("; ");
  return {
    ...base,
    headers: (base.headers ?? []).map((e) => ({ ...e, headers: e.headers.map((h) => (h.value.includes(placeholder) ? { ...h, value: fill(h.value) } : h)) })),
  };
}

export function vercelServe(config, files, path) {
  const set = new Set(files);
  const file = path === "/" ? "index.html" : path.slice(1);
  let status = 404;
  let served = null;
  if (set.has(file)) [status, served] = [200, file];
  else {
    for (const r of config.rewrites ?? []) {
      if (new RegExp(`^${r.source}$`).test(path) && set.has(r.destination.slice(1))) {
        [status, served] = [200, r.destination.slice(1)];
        break;
      }
    }
  }
  const headers = new Map();
  for (const e of config.headers ?? []) {
    if (!new RegExp(`^${e.source}$`).test(path)) continue;
    for (const h of e.headers) headers.set(h.key.toLowerCase(), h.value);
  }
  if (status === 200 && !headers.has("cache-control")) headers.set("cache-control", DEFAULT_CACHE);
  return { status, served, headers, hops: [path] };
}

// ───────────────────────────── Cloudflare Pages ─────────────────────────────

/** `_headers` text → [{ path, test, set: Map(lower → {name, value}), unset: [lower] }] */
export function parseHeadersRules(text) {
  const rules = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (raw.length > 2000) continue; // the parser skips it (pagesLimits.mjs reports it)
    if (/^\S/.test(raw)) {
      const path = raw.trim();
      const body = path
        .split(/(\*|:[A-Za-z]\w*)/)
        .map((p) => (p === "*" ? ".*" : p.startsWith(":") ? "[^/]+" : p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      cur = { path, test: new RegExp(`^${body}$`), set: new Map(), unset: [] };
      rules.push(cur);
      continue;
    }
    if (!cur) continue;
    const detach = /^\s+!\s*([A-Za-z0-9-]+)\s*$/.exec(raw);
    if (detach) {
      cur.unset.push(detach[1].toLowerCase());
      continue;
    }
    const m = /^\s+([A-Za-z0-9-]+):\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const lower = m[1].toLowerCase();
    const prev = cur.set.get(lower);
    cur.set.set(lower, { name: m[1], value: prev ? `${prev.value}, ${m[2]}` : m[2] });
  }
  return rules;
}

function pagesAsset(set, path) {
  if (path.endsWith("/index.html") && set.has(path.slice(1))) return { redirect: path.slice(0, -"index.html".length) };
  if (path.endsWith(".html") && set.has(path.slice(1))) return { redirect: path.slice(0, -".html".length) };
  if (path.endsWith("/index") && set.has(`${path.slice(1)}.html`)) return { redirect: path.slice(0, -"index".length) };
  const file = path === "/" ? "index.html" : path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
  if (set.has(file)) return { file };
  if (set.has(`${file}.html`)) return { file: `${file}.html` };
  if (set.has(`${file}/index.html`)) return { redirect: `${path}/` };
  let cwd = path;
  while (cwd) {
    cwd = cwd.slice(0, cwd.lastIndexOf("/"));
    if (set.has(`${cwd}/404.html`.slice(1))) return { file: `${cwd}/404.html`.slice(1), status: 404 };
  }
  if (set.has("index.html")) return { file: "index.html" };
  return { status: 404 };
}

function pagesHeaders(rules, path) {
  const headers = new Map();
  const seen = new Set();
  for (const rule of rules) {
    if (!rule.test.test(path)) continue;
    for (const name of rule.unset) headers.delete(name);
    for (const [lower, { value }] of rule.set) {
      if (seen.has(lower) && headers.has(lower)) headers.set(lower, `${headers.get(lower)}, ${value}`);
      else headers.set(lower, value);
      seen.add(lower);
    }
  }
  return headers;
}

export function pagesServe(rules, files, path, maxHops = 3) {
  const set = new Set(files);
  const hops = [path];
  let at = path;
  for (let i = 0; i <= maxHops; i++) {
    const r = pagesAsset(set, at);
    if (r.redirect && i < maxHops) {
      at = r.redirect;
      hops.push(at);
      continue;
    }
    const status = r.status ?? 200;
    const headers = pagesHeaders(rules, at);
    if (status === 404) headers.set("cache-control", "no-store");
    else if (!headers.has("cache-control")) headers.set("cache-control", DEFAULT_CACHE);
    return { status, served: r.file ?? null, headers, hops };
  }
  return { status: 508, served: null, headers: new Map(), hops };
}

// ───────────────────────────── comparison ─────────────────────────────

/** A header value in a form that compares equal across hosts. */
export function normalize(name, value) {
  if (value === undefined) return undefined;
  if (name !== "content-security-policy") return value.replace(/\s+/g, " ").trim();
  const { policy, conflicts } = combineCspParts([value]);
  if (conflicts.length) return `CONFLICT(${conflicts.join(",")}) ${value}`;
  return [...policy]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, v]) => (v.length ? `${d} ${v.join(" ")}` : d))
    .join("; ");
}

/** One probe on both hosts → { path, why, same, diffs: string[], accepted?: string, a, b } */
export function compareProbe(path, why, a, b) {
  const diffs = [];
  if (a.status !== b.status) diffs.push(`status ${a.status} ≠ ${b.status}`);
  if (a.served !== b.served && !(a.status === 404 && b.status === 404)) diffs.push(`file ${a.served} ≠ ${b.served}`);
  for (const name of COMPARED) {
    if (name === "cache-control" && a.status === 404 && b.status === 404) continue; // nobody caches a 404 by these rules
    // X-Frame-Options only means something on a document; Vercel leaves it off the worker scripts, Pages sends it.
    if (name === "x-frame-options" && ![a.served, b.served].some((f) => f?.endsWith(".html"))) continue;
    const va = normalize(name, a.headers.get(name));
    const vb = normalize(name, b.headers.get(name));
    if (va !== vb) diffs.push(`${name}: ${va ?? "(none)"} ≠ ${vb ?? "(none)"}`);
  }
  const accepted = diffs.length ? ACCEPTED[path] : undefined;
  return { path, why, same: diffs.length === 0, diffs, accepted, a, b };
}

/**
 * Both hosts from their configs. vercelBase: parsed deploy/vercel.base.json;
 * headersText: public/_headers (or dist/_headers); files: the dist file list
 * (POSIX, no leading slash); pagesExtra: files only the Pages upload has
 * (the 404.html pages of pagesLimits.mjs NOT_FOUND_DIRS); origins: the build's
 * endpoint origins (dist/.csp-connect-extra), filled into Vercel's placeholder.
 */
export function compareConfigs({ vercelBase, headersText, files, pagesExtra = [], origins = [], probes = PROBES }) {
  const vercel = fillVercel(vercelBase, origins);
  const rules = parseHeadersRules(headersText);
  const pagesFiles = [...files, ...pagesExtra];
  const results = probes.map(([path, why]) => compareProbe(path, why, vercelServe(vercel, files, path), pagesServe(rules, pagesFiles, path)));
  return summarize(results);
}

export function summarize(results) {
  const failed = results.filter((r) => !r.same && !r.accepted);
  return { results, same: results.filter((r) => r.same).length, accepted: results.filter((r) => !r.same && r.accepted).length, failed: failed.length, ok: failed.length === 0 };
}

/** The probes against two deployed origins (`fetch` follows redirects; the final URL is recorded). */
export async function liveProbe(originA, originB, { probes = PROBES, fetchImpl = fetch } = {}) {
  const get = async (origin, path) => {
    const res = await fetchImpl(new URL(path, origin), { redirect: "follow", headers: { "cache-control": "no-cache" } });
    const headers = new Map();
    res.headers.forEach((v, k) => headers.set(k.toLowerCase(), v));
    const body = res.status === 200 ? await res.text() : "";
    // The file is unknown from outside: compare a fingerprint of the body instead.
    const html = (res.headers.get("content-type") ?? "").includes("text/html") ? ".html" : "";
    return { status: res.status, served: res.status === 200 ? fingerprint(body) + html : null, headers, hops: [path, new URL(res.url).pathname] };
  };
  const results = [];
  for (const [path, why] of probes) results.push(compareProbe(path, why, await get(originA, path), await get(originB, path)));
  return summarize(results);
}

/** A short, stable fingerprint of a response body (FNV-1a, enough to tell two files apart). */
export function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv:${h.toString(16)}:${text.length}`;
}
