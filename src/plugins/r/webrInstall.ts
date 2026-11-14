/**
 * webR (R compiled to WebAssembly) as a user-initiated download (plan W1.34).
 *
 * webR's binaries (R, libgfortran) are GPL-3.0, so Lumen's build ships none
 * of webR. The R block offers this download, with the licence first; it:
 *
 *  1. reads this build's manifest (runtimes/webr.json, src/build/webrManifest.ts):
 *     the webR version, and every file with its size and SHA-256;
 *  2. fetches each file from webR's own CDN for that version
 *     (webr.r-wasm.org/v<version>/), or from the npm package on jsDelivr if
 *     that fails, and refuses any file whose size or hash differs;
 *  3. stores it in the webr runtime cache under <base>webr/, where the
 *     service worker serves it same-origin (CacheFirst), so R loads under
 *     the app's CSP and works offline from then on. The worker script gets
 *     the same preludes and headers a self-hosted copy has
 *     (webrRuntime.json, the eval-workers CSP).
 *
 * Nothing about the user's notes is sent; the privacy ledger records the
 * requests as a model download. A deployment that serves its own copy
 * (`npm run webr:local`) needs none of this: webrAvailable() sees it.
 */
import runtime from "./webrRuntime.json";
import { webrBaseUrl } from "./webrPaths";

export const WEBR_MANIFEST_PATH = "runtimes/webr.json";
/** Marker stored last: the cache holds a complete, verified download. */
export const WEBR_INSTALLED_MARKER = ".lumen-installed";

/** [path under dist/, size, SHA-256 base64] — see src/build/webrManifest.ts. */
export type WebRManifestFile = [path: string, size: number, sha256: string];
export interface WebRManifest {
  version: string;
  files: WebRManifestFile[];
  bytes: number;
  workerCsp: string;
}

/**
 * Where a file comes from, in order: webR's own CDN for that release (its
 * documented browser download; the npm package's dist/ is built from the
 * same release files, its browser module copied as webr.js), then the npm
 * package itself on jsDelivr. Either way the bytes must match the manifest.
 */
export function webrSources(version: string): Array<(path: string) => string> {
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  return [
    (p) => `https://webr.r-wasm.org/v${version}/${enc(p === "webr.js" ? "webr.mjs" : p)}`,
    (p) => `https://cdn.jsdelivr.net/npm/webr@${version}/dist/${enc(p)}`,
  ];
}

export type WebRInstallErrorCode = "no-manifest" | "no-cache" | "download" | "mismatch" | "aborted";
export class WebRInstallError extends Error {
  constructor(
    readonly code: WebRInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebRInstallError";
  }
}

const appBase = (): string => (import.meta.env?.BASE_URL as string | undefined) ?? "/";
/** An absolute URL for a path on this origin (Cache Storage keys are absolute). */
const absolute = (path: string): string => new URL(path, typeof location !== "undefined" ? location.href : "http://localhost/").href;

/** The service worker's runtime cache for webR (named per version), or null without one. */
export function webrCacheName(names: readonly string[] = typeof __LUMEN_RUNTIME_CACHES__ === "undefined" ? [] : __LUMEN_RUNTIME_CACHES__): string | null {
  return names.find((n) => n.startsWith("lumen-runtime-webr-")) ?? null;
}

export async function fetchWebRManifest(base = appBase(), fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<WebRManifest> {
  let res: Response;
  try {
    res = await fetchImpl(`${base.replace(/\/?$/, "/")}${WEBR_MANIFEST_PATH}`, { cache: "no-cache" });
  } catch (e) {
    throw new WebRInstallError("no-manifest", e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new WebRInstallError("no-manifest", `HTTP ${res.status}`);
  const m = (await res.json()) as WebRManifest;
  if (!m || typeof m.version !== "string" || !Array.isArray(m.files) || !m.files.length) throw new WebRInstallError("no-manifest", "malformed manifest");
  return m;
}

function contentType(path: string): string {
  if (/\.m?js$/.test(path)) return "text/javascript; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

const SOURCE_MAP_LINE = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*\r?\n?/gm;

/** The bytes as Lumen serves them: the worker gets its preludes; no source-map comments (plan 11.5). */
export function prepareWebRFile(path: string, bytes: ArrayBuffer): BodyInit {
  if (!/\.m?js$/.test(path)) return bytes;
  let text = new TextDecoder().decode(bytes).replace(SOURCE_MAP_LINE, "");
  if (path === "webr-worker.js" && !text.startsWith("/* Lumen:")) text = runtime.trustedTypes + runtime.isolation + text;
  return text;
}

export function webrHeaders(path: string, manifest: Pick<WebRManifest, "workerCsp">): Headers {
  const h = new Headers({ "Content-Type": contentType(path), "X-Content-Type-Options": "nosniff" });
  // A cached response carries no server headers: give the worker the policy
  // the eval-workers route gives a self-hosted /webr/webr-worker.js.
  if (path === "webr-worker.js") h.set("Content-Security-Policy", manifest.workerCsp);
  return h;
}

async function sha256Base64(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let s = "";
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s);
}

export interface InstallOptions {
  base?: string;
  manifest?: WebRManifest;
  fetchImpl?: typeof fetch;
  cachesImpl?: CacheStorage;
  cacheName?: string | null;
  signal?: AbortSignal;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  /** Files fetched at once. */
  concurrency?: number;
}

/** One file, from the first source that serves exactly the manifest's bytes. */
async function fetchVerified(file: WebRManifestFile, sources: Array<(path: string) => string>, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ArrayBuffer> {
  const [path, size, hash] = file;
  let last: WebRInstallError | null = null;
  for (const src of sources) {
    if (signal?.aborted) throw new WebRInstallError("aborted", "cancelled");
    let res: Response;
    try {
      res = await fetchImpl(src(path), { signal, credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (e) {
      if (signal?.aborted) throw new WebRInstallError("aborted", "cancelled");
      last = new WebRInstallError("download", `${path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!res.ok) {
      last = new WebRInstallError("download", `${path}: HTTP ${res.status}`);
      continue;
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength !== size || (await sha256Base64(bytes)) !== hash) {
      last = new WebRInstallError("mismatch", `${path}: does not match this build's checksum`);
      continue;
    }
    return bytes;
  }
  throw last ?? new WebRInstallError("download", path);
}

/**
 * Download, verify and store webR. Resolves when every file is in the cache
 * (the marker last); on any failure the cache is deleted, so a partial
 * download is never served.
 */
export async function installWebR(opts: InstallOptions = {}): Promise<WebRManifest> {
  const base = (opts.base ?? appBase()).replace(/\/?$/, "/");
  const fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  const storage = opts.cachesImpl ?? globalThis.caches;
  const cacheName = opts.cacheName === undefined ? webrCacheName() : opts.cacheName;
  if (!storage || !cacheName) throw new WebRInstallError("no-cache", "no runtime cache");
  const manifest = opts.manifest ?? (await fetchWebRManifest(base, fetchImpl));
  const sources = webrSources(manifest.version);
  const root = webrBaseUrl(base);
  const cache = await storage.open(cacheName);
  let done = 0;
  opts.onProgress?.(0, manifest.bytes);
  try {
    const queue = [...manifest.files];
    // The first failure stops every worker; the cache is deleted only once
    // they have all stopped, so no late write outlives it.
    let failure: unknown = null;
    const worker = async () => {
      for (let f = queue.shift(); f && !failure; f = queue.shift()) {
        try {
          const bytes = await fetchVerified(f, sources, fetchImpl, opts.signal);
          if (failure) return;
          await cache.put(new Request(absolute(root + f[0])), new Response(prepareWebRFile(f[0], bytes), { headers: webrHeaders(f[0], manifest) }));
          done += f[1];
          opts.onProgress?.(done, manifest.bytes);
        } catch (e) {
          failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
    if (failure) throw failure;
    await cache.put(new Request(absolute(root + WEBR_INSTALLED_MARKER)), new Response(manifest.version, { headers: { "Content-Type": "text/plain" } }));
  } catch (e) {
    await storage.delete(cacheName).catch(() => false);
    throw e instanceof WebRInstallError ? e : new WebRInstallError("download", e instanceof Error ? e.message : String(e));
  }
  return manifest;
}

/** Is webR here: downloaded into the runtime cache, or served by this deployment itself? */
export async function webrAvailable(opts: { base?: string; fetchImpl?: typeof fetch; cachesImpl?: CacheStorage; cacheName?: string | null } = {}): Promise<boolean> {
  const base = (opts.base ?? appBase()).replace(/\/?$/, "/");
  const storage = opts.cachesImpl ?? globalThis.caches;
  const cacheName = opts.cacheName === undefined ? webrCacheName() : opts.cacheName;
  const root = webrBaseUrl(base);
  try {
    if (storage && cacheName && (await storage.has(cacheName))) {
      const cache = await storage.open(cacheName);
      if (await cache.match(absolute(root + WEBR_INSTALLED_MARKER))) return true;
    }
  } catch {
    /* why: Cache Storage unavailable (private mode): fall back to asking the server */
  }
  try {
    const fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    const res = await fetchImpl(`${root}webr.js`, { method: "GET", cache: "no-cache" });
    // A dev server or an SPA host may answer a missing file with index.html.
    return res.ok && /javascript/.test(res.headers.get("content-type") ?? "");
  } catch {
    return false;
  }
}
