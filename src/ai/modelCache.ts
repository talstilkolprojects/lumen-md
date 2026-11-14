/**
 * transformers.js cache for the self-converted models (plan 6.0): their files
 * live in OPFS (`models/<id>/<path>`), and a file is stored only when its
 * size and sha256 match models/registry.json. Every other URL (Whisper, e5,
 * the reranker from Hugging Face) goes to the browser Cache API as before.
 *
 * Used as `env.customCache` in src/ai/transformers.worker.ts once
 * CONVERTED_MODELS_BASE is set (15.9). It never fetches anything itself:
 * transformers.js downloads, and only after the user agreed
 * (requestConvertedModel in ./convertedModels.ts).
 */
import type { ConvertedDtype, RegistryFile, RegistryModel } from "./convertedModels";

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

type Dir = FileSystemDirectoryHandle;

const ROOT_DIR = "models";

/** `${base}${id}/${path}` → { id, path }, or null for a URL that is not one of ours. */
export function parseModelUrl(key: string, base: string): { id: string; path: string } | null {
  const b = base.endsWith("/") ? base : base + "/";
  if (!key.startsWith(b)) return null;
  const rest = key.slice(b.length).split(/[?#]/)[0];
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const id = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (!path || path.split("/").some((p) => !p || p === "." || p === "..")) return null;
  return { id, path };
}

async function dirFor(root: Dir, parts: string[], create: boolean): Promise<Dir | null> {
  let d = root;
  try {
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  } catch {
    return null;
  }
}

async function readFile(root: Dir, id: string, path: string): Promise<File | null> {
  const parts = path.split("/");
  const dir = await dirFor(root, [ROOT_DIR, id, ...parts.slice(0, -1)], false);
  if (!dir) return null;
  try {
    return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  } catch {
    return null;
  }
}

async function writeFile(root: Dir, id: string, path: string, data: ArrayBuffer): Promise<void> {
  const parts = path.split("/");
  const dir = await dirFor(root, [ROOT_DIR, id, ...parts.slice(0, -1)], true);
  if (!dir) throw new Error(`cannot create the OPFS folder for ${id}/${path}`);
  const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const h = handle as unknown as {
    createWritable?: () => Promise<{ write(d: ArrayBuffer): Promise<void>; close(): Promise<void> }>;
    createSyncAccessHandle?: () => Promise<{ truncate(n: number): void; write(d: ArrayBuffer, o: { at: number }): number; flush(): void; close(): void }>;
  };
  if (typeof h.createWritable === "function") {
    const w = await h.createWritable();
    await w.write(data);
    await w.close();
  } else if (typeof h.createSyncAccessHandle === "function") {
    // Safari's workers: no createWritable, a synchronous handle instead.
    const s = await h.createSyncAccessHandle();
    try {
      s.truncate(0);
      s.write(data, { at: 0 });
      s.flush();
    } finally {
      s.close();
    }
  } else {
    throw new Error("OPFS writes are not available here");
  }
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ModelCacheOptions {
  /** Where the converted models are served from (CONVERTED_MODELS_BASE). */
  base: string;
  /** Registry entries of the converted models, by id. */
  registry: Map<string, RegistryModel>;
  /** OPFS root (navigator.storage.getDirectory()). */
  root: () => Promise<Dir>;
  /** Everything else: the Cache API, as transformers.js uses by default. */
  fallback: () => Promise<CacheLike>;
}

/** The registry entry for one file of a converted model, or null. */
function expected(registry: Map<string, RegistryModel>, id: string, path: string): RegistryFile | null {
  return registry.get(id)?.files?.find((f) => f.path === path) ?? null;
}

export function createModelCache(opts: ModelCacheOptions): CacheLike {
  return {
    async match(key) {
      const ours = parseModelUrl(key, opts.base);
      if (!ours) return (await opts.fallback()).match(key);
      const want = expected(opts.registry, ours.id, ours.path);
      const file = await readFile(await opts.root(), ours.id, ours.path);
      // A size that differs is a partial or stale copy: download it again.
      if (!file || (want && file.size !== want.bytes)) return undefined;
      // A File streams from disk; where it cannot (no Blob.stream), read it whole.
      const body = typeof (file as Blob).stream === "function" ? file : await file.arrayBuffer();
      return new Response(body, { headers: { "content-length": String(file.size) } });
    },
    async put(key, response) {
      const ours = parseModelUrl(key, opts.base);
      if (!ours) return (await opts.fallback()).put(key, response);
      const want = expected(opts.registry, ours.id, ours.path);
      if (!want) throw new Error(`${ours.id}/${ours.path} is not in models/registry.json: not cached`);
      const data = await response.arrayBuffer();
      if (data.byteLength !== want.bytes) throw new Error(`${ours.id}/${ours.path}: ${data.byteLength} bytes, expected ${want.bytes}`);
      const sum = await sha256Hex(data);
      if (sum !== want.sha256) throw new Error(`${ours.id}/${ours.path}: checksum mismatch (got ${sum.slice(0, 12)}…, expected ${want.sha256.slice(0, 12)}…)`);
      await writeFile(await opts.root(), ours.id, ours.path, data);
    },
  };
}

/** Is every file of `id` in `dtype` already in OPFS, at the expected size? (No prompt needed then.) */
export async function isModelCached(root: Dir, entry: RegistryModel, dtype: ConvertedDtype): Promise<boolean> {
  const files = (entry.files ?? []).filter((f) => f.dtype === dtype || f.dtype === "config");
  // Configs alone are not a model: the dtype needs its own ONNX files.
  if (!files.some((f) => f.dtype === dtype)) return false;
  for (const f of files) {
    const file = await readFile(root, entry.id, f.path);
    if (!file || file.size !== f.bytes) return false;
  }
  return true;
}

/** Remove a downloaded model from OPFS (settings → models → remove). */
export async function removeCachedModel(root: Dir, id: string): Promise<void> {
  const dir = await dirFor(root, [ROOT_DIR], false);
  try {
    await dir?.removeEntry(id, { recursive: true });
  } catch {
    /* why: not downloaded */
  }
}
