/**
 * Model hosting without depending on Hugging Face (plan W4.14).
 *
 * Every downloadable model in models/registry.json can name where its files
 * come from (`hosting`) and list them with their sha256 and size (`files`).
 * A file is then fetched from the first source that answers with exactly
 * those bytes, in this order:
 *
 *   1. Hugging Face, at the pinned revision (`hosting.hf` + `hosting.revision`);
 *   2. Lumen's mirror: GitHub Releases of the repo (one release per model,
 *      tag `models-<slug>`, ≤ 2 GiB per file), read through a small CORS
 *      proxy (edge-workers/model-mirror) because GitHub's release downloads
 *      send no Access-Control-Allow-Origin header — VITE_MODEL_MIRROR_URL;
 *   3. a URL the user gives (their own copy of a release, same layout), or
 *      files they pick on this device (matched by sha256, any file name).
 *
 * Every source is checked the same way: size, then sha256 against the
 * registry. A file with no sha256 in the registry is only ever taken from
 * Hugging Face at a pinned commit (which fixes its content); mirrors and user
 * sources must be verifiable. `npm run models:mirror -- --check` lists every
 * model whose files are not pinned yet.
 *
 * Verified files go into the cache the loading library reads (web-llm's
 * "webllm/model", transformers.js's "transformers-cache", dictation's own
 * cache) under the URL the library asks for, so the library then loads them
 * without a request of its own. Models with no pinned file list keep the
 * library's own download, unchanged.
 *
 * Pure logic plus injected fetch / cache / digest, so it runs in a window or
 * a worker and in tests.
 */

export interface HostedFile {
  /** Path inside the model repository ("onnx/encoder_model_q4f16.onnx"). */
  path: string;
  /** Hex sha256 of the file. */
  sha256: string;
  bytes: number;
  dtype?: string;
  /** The URL the loading library requests, when it is not `<hf>/resolve/<keyRev>/<path>` (web-llm's model lib). */
  key?: string;
  /** The Cache API cache the library reads this file from, when it differs from `hosting.cache`. */
  cache?: string;
}

export interface Hosting {
  /** Hugging Face repository ("onnx-community/whisper-base"). */
  hf?: string;
  /** The pinned commit on Hugging Face; null until `models:mirror -- --pin` fills it. */
  revision?: string | null;
  /** Cache API cache the loading library reads ("webllm/model", "transformers-cache", …). */
  cache?: string;
  /** The revision in the URLs the library requests (default "main"). */
  keyRev?: string;
  /** GitHub release tag on the mirror (default `models-<slug of id>`). */
  tag?: string;
  /** transformers.js: the ONNX dtypes the app loads, the only ones mirrored (scripts/models/mirror.mjs). */
  dtypes?: string[];
  /** web-llm: the model library (.wasm) the engine fetches for this model. */
  lib?: string;
  /**
   * "converted": a model Lumen converts itself (plan 6.0). It has no Hugging
   * Face copy; it is served from the mirror as CONVERTED_MODELS_BASE and
   * cached in OPFS by ./modelCache.ts, which checks the same sha256.
   */
  via?: "converted";
  /** Files the library needs that have no published sha256 yet (fetched only from the pinned revision). */
  unpinned?: string[];
}

export interface HostedModel {
  id: string;
  class?: string;
  delivery?: string;
  runs?: string;
  hosting?: Hosting;
  files?: HostedFile[];
}

export type SourceKind = "hf" | "mirror" | "user";

export interface Candidate {
  kind: SourceKind;
  url: string;
}

export interface SourceConfig {
  /** Lumen's mirror (the CORS proxy in front of GitHub Releases), or null when not deployed. */
  mirror: string | null;
  /** The user's own copy, or null. */
  user: string | null;
}

/** GitHub's per-file limit for release assets (2 GiB). */
export const GITHUB_RELEASE_MAX_BYTES = 2 * 1024 ** 3;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

export const hasSha = (f: Pick<HostedFile, "sha256">): boolean => typeof f.sha256 === "string" && HEX64.test(f.sha256);

/** "onnx-community/whisper-base" → "onnx-community-whisper-base" (a release tag segment). */
export function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function releaseTag(m: Pick<HostedModel, "id" | "hosting">): string {
  return m.hosting?.tag ?? `models-${slug(m.id)}`;
}

/** Release assets are flat: "onnx/encoder.onnx" is published as "onnx__encoder.onnx". */
export function assetName(path: string): string {
  return path.split("/").join("__");
}

/** The inverse of assetName (the proxy and user copies accept both forms). */
export function pathFromAsset(name: string): string {
  return name.split("__").join("/");
}

/** A repository-relative path that cannot climb out of its folder. */
export function safePath(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((p) => !!p && p !== "." && p !== "..");
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function hfUrl(repo: string, revision: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${enc(path)}`;
}

const trimBase = (u: string) => u.trim().replace(/\/+$/, "");

/** The URL the loading library requests for `f`, i.e. the cache key, or null when the model has no HF repo and no explicit key. */
export function libraryKey(m: HostedModel, f: HostedFile): string | null {
  if (f.key) return f.key;
  const hf = m.hosting?.hf;
  return hf ? hfUrl(hf, m.hosting?.keyRev ?? "main", f.path) : null;
}

export function cacheNameFor(m: HostedModel, f: HostedFile): string | null {
  return f.cache ?? m.hosting?.cache ?? null;
}

/**
 * Where `f` may come from, in order. A file without a sha256 can only come
 * from Hugging Face at a pinned commit; with no pin it has no source at all.
 */
export function candidates(m: HostedModel, f: HostedFile, cfg: SourceConfig): Candidate[] {
  if (!safePath(f.path)) return [];
  const out: Candidate[] = [];
  const h = m.hosting;
  const pinned = !!h?.revision && HEX40.test(h.revision);
  if (h?.hf) {
    if (hasSha(f) || pinned) out.push({ kind: "hf", url: hfUrl(h.hf, pinned ? (h.revision as string) : "main", f.path) });
  } else if (f.key && /^https:\/\//.test(f.key) && hasSha(f)) {
    // A file the library fetches from its own host (web-llm's model lib on GitHub).
    out.push({ kind: "hf", url: f.key });
  }
  if (!hasSha(f)) return out;
  const tag = releaseTag(m);
  if (cfg.mirror) out.push({ kind: "mirror", url: `${trimBase(cfg.mirror)}/${tag}/${enc(f.path)}` });
  if (cfg.user) out.push({ kind: "user", url: `${trimBase(cfg.user)}/${tag}/${encodeURIComponent(assetName(f.path))}` });
  return out;
}

export interface Attempt {
  kind: SourceKind;
  url: string;
  error: string;
}

export class ModelSourcesError extends Error {
  readonly path: string;
  readonly attempts: Attempt[];
  // why: no parameter properties — scripts/models/mirror.mjs loads this file with --experimental-strip-types
  constructor(path: string, attempts: Attempt[]) {
    super(
      attempts.length
        ? `${path}: no source gave the expected file (${attempts.map((a) => `${a.kind}: ${a.error}`).join("; ")})`
        : `${path}: no source to download it from (no pinned checksum, no mirror)`,
    );
    this.name = "ModelSourcesError";
    this.path = path;
    this.attempts = attempts;
  }
}

export interface FetchDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Hex sha256 of the bytes (crypto.subtle by default). */
  digest?: (data: Uint8Array<ArrayBuffer>) => Promise<string>;
  onBytes?: (n: number) => void;
  signal?: AbortSignal;
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

async function readAll(res: Response, onBytes?: (n: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    onBytes?.(b.length);
    return b;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onBytes?.(value.length);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Fetch `f` from the first candidate whose bytes match the registry: size
 * first (cheap), then sha256. A source that fails or serves other bytes is
 * skipped and recorded; an abort stops at once.
 */
export async function fetchVerified(
  f: Pick<HostedFile, "path" | "sha256" | "bytes">,
  cands: Candidate[],
  deps: FetchDeps,
): Promise<{ data: Uint8Array<ArrayBuffer>; source: Candidate; attempts: Attempt[] }> {
  const digest = deps.digest ?? sha256Hex;
  const attempts: Attempt[] = [];
  for (const c of cands) {
    if (deps.signal?.aborted) throw new DOMException("aborted", "AbortError");
    let counted = 0;
    try {
      // privacy-ledger: model-download — Hugging Face (ledger rule), Lumen's mirror (VITE_MODEL_MIRROR_URL rule) or the user's own copy; window.fetch / the worker ledger record it
      const res = await deps.fetch(c.url, { signal: deps.signal });
      if (!res.ok) {
        attempts.push({ ...c, error: `HTTP ${res.status}` });
        continue;
      }
      const data = await readAll(res, (n) => {
        counted += n;
        deps.onBytes?.(n);
      });
      if (f.bytes > 0 && data.length !== f.bytes) {
        attempts.push({ ...c, error: `${data.length} bytes, expected ${f.bytes}` });
        deps.onBytes?.(-counted);
        continue;
      }
      if (hasSha(f)) {
        const sum = await digest(data);
        if (sum !== f.sha256) {
          attempts.push({ ...c, error: `sha256 ${sum.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…` });
          deps.onBytes?.(-counted);
          continue;
        }
      }
      return { data, source: c, attempts };
    } catch (e) {
      if (isAbort(e) || deps.signal?.aborted) throw e;
      if (counted) deps.onBytes?.(-counted);
      attempts.push({ ...c, error: e instanceof Error ? e.message : String(e) });
    }
  }
  throw new ModelSourcesError(f.path, attempts);
}

export interface CacheStore {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

export interface EnsureDeps extends FetchDeps {
  sources: SourceConfig;
  open: (cacheName: string) => Promise<CacheStore>;
  /** Only these files (e.g. one dtype); default: all of the model's files. */
  filter?: (f: HostedFile) => boolean;
}

export interface EnsureReport {
  /** Files already in the library's cache. */
  cached: number;
  /** Files downloaded now, with the source that served each. */
  fetched: Array<{ path: string; kind: SourceKind }>;
  /** Files with no cache key or cache name (nothing to prefill). */
  skipped: number;
}

/**
 * Put every pinned file of `m` into the cache its library reads, verified.
 * Throws ModelSourcesError for the first file no source could serve; files
 * stored before it stay (a retry continues from there).
 */
export async function ensureModelFiles(m: HostedModel, deps: EnsureDeps): Promise<EnsureReport> {
  const report: EnsureReport = { cached: 0, fetched: [], skipped: 0 };
  const opened = new Map<string, CacheStore>();
  for (const f of (m.files ?? []).filter(deps.filter ?? (() => true))) {
    const key = libraryKey(m, f);
    const name = cacheNameFor(m, f);
    if (!key || !name) {
      report.skipped++;
      continue;
    }
    let cache = opened.get(name);
    if (!cache) {
      cache = await deps.open(name);
      opened.set(name, cache);
    }
    if (await cache.match(key)) {
      report.cached++;
      deps.onBytes?.(f.bytes);
      continue;
    }
    const { data, source } = await fetchVerified(f, candidates(m, f, deps.sources), deps);
    await cache.put(key, new Response(data, { headers: { "content-type": "application/octet-stream", "content-length": String(data.length) } }));
    report.fetched.push({ path: f.path, kind: source.kind });
  }
  return report;
}

/** Total bytes of the files ensureModelFiles would handle. */
export function hostedBytes(m: HostedModel, filter?: (f: HostedFile) => boolean): number {
  return (m.files ?? []).filter(filter ?? (() => true)).reduce((s, f) => s + (f.bytes || 0), 0);
}

/**
 * Files the user picked on this device: each is kept when its size and
 * sha256 match a registry file (any name), stored where its library reads it.
 */
export async function importLocalModelFiles(
  picked: Array<{ name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }>,
  models: HostedModel[],
  deps: { open: (cacheName: string) => Promise<CacheStore>; digest?: (d: Uint8Array<ArrayBuffer>) => Promise<string> },
): Promise<{ stored: Array<{ model: string; path: string }>; unknown: string[] }> {
  const digest = deps.digest ?? sha256Hex;
  const bySize = new Map<number, Array<{ m: HostedModel; f: HostedFile }>>();
  for (const m of models) {
    for (const f of m.files ?? []) {
      if (!hasSha(f) || !libraryKey(m, f) || !cacheNameFor(m, f)) continue;
      const list = bySize.get(f.bytes) ?? [];
      list.push({ m, f });
      bySize.set(f.bytes, list);
    }
  }
  const stored: Array<{ model: string; path: string }> = [];
  const unknown: string[] = [];
  for (const file of picked) {
    const options = bySize.get(file.size);
    if (!options) {
      unknown.push(file.name);
      continue;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const sum = await digest(data);
    const hits = options.filter((o) => o.f.sha256 === sum);
    if (!hits.length) {
      unknown.push(file.name);
      continue;
    }
    // One file can be several registry entries (a shared model lib): store each.
    for (const { m, f } of hits) {
      const cache = await deps.open(cacheNameFor(m, f) as string);
      await cache.put(libraryKey(m, f) as string, new Response(data, { headers: { "content-type": "application/octet-stream", "content-length": String(data.length) } }));
      stored.push({ model: m.id, path: f.path });
    }
  }
  return { stored, unknown };
}

/** A downloadable model that may be a default: allowed licence, runs in the app. */
export const isDefaultCandidate = (m: HostedModel): boolean => m.delivery === "download" && m.class === "allowed" && m.runs === "browser";

export interface HostingGap {
  id: string;
  problem: string;
}

/**
 * What still stops a model from downloading without Hugging Face: no file
 * list, an unpinned revision, a file without a sha256, a file GitHub cannot
 * hold. `models:mirror -- --check --strict` fails on any of these.
 */
export function hostingGaps(models: HostedModel[], only: (m: HostedModel) => boolean = isDefaultCandidate): HostingGap[] {
  const out: HostingGap[] = [];
  for (const m of models.filter(only)) {
    const h = m.hosting;
    if (!h) {
      out.push({ id: m.id, problem: "no hosting entry" });
      continue;
    }
    if (h.hf && !(h.revision && HEX40.test(h.revision))) out.push({ id: m.id, problem: "Hugging Face revision not pinned" });
    if (!m.files?.length) {
      out.push({ id: m.id, problem: "file list not pinned (no files)" });
      continue;
    }
    for (const path of h.unpinned ?? []) out.push({ id: m.id, problem: `${path}: no sha256 (taken only from the pinned Hugging Face revision)` });
    const seen = new Set<string>();
    for (const f of m.files) {
      if (!safePath(f.path)) out.push({ id: m.id, problem: `${f.path}: unsafe path` });
      if (!hasSha(f)) out.push({ id: m.id, problem: `${f.path}: no sha256` });
      if (!(f.bytes > 0)) out.push({ id: m.id, problem: `${f.path}: no size` });
      if (f.bytes > GITHUB_RELEASE_MAX_BYTES) out.push({ id: m.id, problem: `${f.path}: ${f.bytes} bytes is over GitHub's 2 GiB per file` });
      if (seen.has(assetName(f.path))) out.push({ id: m.id, problem: `${f.path}: two files share the asset name ${assetName(f.path)}` });
      seen.add(assetName(f.path));
      if (h.via !== "converted" && (!libraryKey(m, f) || !cacheNameFor(m, f))) out.push({ id: m.id, problem: `${f.path}: no cache key or cache name` });
    }
  }
  return out;
}

/** The mirror's base URL from the build (VITE_MODEL_MIRROR_URL), or null. */
export function builtMirrorBase(): string | null {
  let raw: string | undefined;
  try {
    // why: a static name read — Vite inlines this one value, not the whole env
    raw = (import.meta.env.VITE_MODEL_MIRROR_URL as string | undefined)?.trim();
  } catch {
    raw = undefined;
  }
  return raw && /^https:\/\//.test(raw) ? trimBase(raw) : null;
}

/**
 * The user's own source. Kept in a tiny Cache API entry, not localStorage,
 * because the model workers read it too.
 */
export const USER_SOURCE_CACHE = "lumen-model-sources";
const USER_SOURCE_KEY = "https://lumen-md.invalid/model-sources/user";

export async function readUserSource(open: (n: string) => Promise<CacheStore> = (n) => caches.open(n)): Promise<string | null> {
  try {
    const res = await (await open(USER_SOURCE_CACHE)).match(USER_SOURCE_KEY);
    const v = res ? ((await res.json()) as { user?: unknown }).user : null;
    return typeof v === "string" && /^https?:\/\//.test(v) ? trimBase(v) : null;
  } catch {
    return null;
  }
}

/** Save (or clear, with "") the user's source. Only http(s) URLs are kept. */
export async function writeUserSource(url: string, open: (n: string) => Promise<CacheStore> = (n) => caches.open(n)): Promise<string | null> {
  const v = url.trim();
  const ok = /^https?:\/\/[^\s/]+/.test(v) ? trimBase(v) : null;
  const cache = await open(USER_SOURCE_CACHE);
  await cache.put(USER_SOURCE_KEY, new Response(JSON.stringify({ user: ok }), { headers: { "content-type": "application/json" } }));
  return ok;
}

export async function currentSources(open?: (n: string) => Promise<CacheStore>): Promise<SourceConfig> {
  return { mirror: builtMirrorBase(), user: await readUserSource(open) };
}

/** The registry's models (lazy: the registry is not in the startup bundle). */
export async function loadHostedModels(): Promise<HostedModel[]> {
  const mod = (await import("../../models/registry.json")) as unknown as { default?: { models: HostedModel[] }; models?: HostedModel[] };
  return (mod.default ?? mod).models ?? [];
}

/** The registry entry whose Hugging Face repo is `repo` (exact), or whose repo ends with `/${name}` (web-llm ids). */
export function findHosted(models: HostedModel[], repoOrName: string): HostedModel | null {
  return (
    models.find((m) => m.hosting?.hf === repoOrName || m.id === repoOrName) ??
    models.find((m) => !!m.hosting?.hf && m.hosting.hf.endsWith(`/${repoOrName}`)) ??
    null
  );
}

/**
 * The library-side hook: before a library loads `repoOrName`, prefill its
 * cache from the source chain when the registry pins the files. Returns null
 * when nothing is pinned (the library downloads as before).
 */
export async function prefillFor(
  repoOrName: string,
  deps: Omit<EnsureDeps, "sources" | "open" | "fetch"> & { fetch?: FetchDeps["fetch"]; sources?: SourceConfig; open?: EnsureDeps["open"]; models?: HostedModel[] },
): Promise<EnsureReport | null> {
  const models = deps.models ?? (await loadHostedModels());
  const m = findHosted(models, repoOrName);
  if (!m?.files?.length) return null;
  const open = deps.open ?? ((n: string) => caches.open(n));
  const sources = deps.sources ?? (await currentSources(open));
  // privacy-ledger: model-download — the global fetch, wrapped by the ledger (window) or workerLedgerInstall (workers)
  const doFetch = deps.fetch ?? ((u: string, init?: RequestInit) => fetch(u, init));
  return ensureModelFiles(m, { ...deps, fetch: doFetch, sources, open });
}

/** File-name suffix of each transformers.js dtype (as in scripts/models/manifest.mjs). */
const DTYPE_SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4" };

/** The dtype an ONNX file name stands for, and its component ("decoder_model_merged_q4.onnx" → q4, decoder_model_merged). */
export function onnxParts(path: string): { component: string; dtype: string } | null {
  const name = path.split("/").pop() ?? "";
  if (!/\.onnx(_data(_\d+)?)?$/.test(name)) return null;
  const stem = name.replace(/\.onnx(_data(_\d+)?)?$/, "");
  for (const [dtype, suffix] of Object.entries(DTYPE_SUFFIX)) {
    if (suffix && stem.endsWith(suffix)) return { component: stem.slice(0, -suffix.length), dtype };
  }
  return { component: stem, dtype: "fp32" };
}

/**
 * Does a transformers.js load with `dtype` (one for all, or one per
 * component) read `path`? Non-ONNX files (configs, tokenizer) always.
 */
export function wantsFile(path: string, dtype: string | Record<string, string> | undefined): boolean {
  const parts = onnxParts(path);
  if (!parts) return true;
  if (dtype === undefined) return true;
  if (typeof dtype === "string") return parts.dtype === dtype;
  const want = dtype[parts.component];
  return want === undefined ? true : parts.dtype === want;
}
