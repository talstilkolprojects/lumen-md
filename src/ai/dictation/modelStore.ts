/**
 * Download and keep live dictation's model files (plan 6.1). Only ever
 * started by the user, after the size was shown; stored in Cache Storage so
 * dictation works offline afterwards. Fetches go through `window.fetch`, so
 * the privacy ledger records them (category "model-download").
 */
import { DICTATION_CACHE, VAD_FILE, ZIPFORMER_FILES, ZIPFORMER_REPO, ZIPFORMER_REVISION, type ModelFile } from "./models";

export interface DictationFiles {
  encoder: Uint8Array;
  decoder: Uint8Array;
  joiner: Uint8Array;
  tokens: string;
  /** Null when the VAD model could not be loaded: dictation then segments on energy. */
  vad: Uint8Array | null;
}

export type Progress = (loaded: number, total: number) => void;

const baseUrl = (): string => (import.meta.env?.BASE_URL as string | undefined) ?? "/";
const resolve = (f: ModelFile): string => (/^https?:/.test(f.url) ? f.url : baseUrl() + f.url);

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches !== "undefined" ? await caches.open(DICTATION_CACHE) : null;
  } catch {
    return null;
  }
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Are the speech model's files on this device? (The VAD is same-origin and small; not required.) */
export async function isDictationModelDownloaded(): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  for (const f of Object.values(ZIPFORMER_FILES)) if (!(await cache.match(resolve(f)))) return false;
  return true;
}

async function fetchFile(f: ModelFile, cache: Cache | null, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const url = resolve(f);
  const hit = await cache?.match(url);
  if (hit) {
    const b = new Uint8Array(await hit.arrayBuffer());
    onBytes(b.length);
    return b;
  }
  // Plan W4.14: Hugging Face at the pinned revision first, then Lumen's
  // mirror and the user's own copy — each answer checked by size and sha256.
  // A file without a sha256 (tokens.txt) comes only from the pinned revision.
  const { candidates, currentSources, fetchVerified } = await import("../modelHosting");
  const cands = f.path
    ? candidates({ id: ZIPFORMER_REPO, hosting: { hf: ZIPFORMER_REPO, revision: ZIPFORMER_REVISION } }, { path: f.path, sha256: f.sha256 ?? "", bytes: f.bytes }, await currentSources())
    : [{ kind: "hf" as const, url }];
  // privacy-ledger: model-download — window.fetch, so the ledger records each source tried
  const { data: out } = await fetchVerified({ path: f.path ?? url, sha256: f.sha256 ?? "", bytes: f.bytes }, cands, { fetch: (u, init) => fetch(u, init), onBytes, signal, digest: sha256Hex });
  try {
    await cache?.put(url, new Response(out, { headers: { "content-type": "application/octet-stream" } }));
  } catch {
    /* why: quota: it still works for this session */
  }
  return out;
}

/** Download (or read from the cache) everything live dictation needs. */
export async function loadDictationFiles(onProgress?: Progress, signal?: AbortSignal): Promise<DictationFiles> {
  const cache = await openCache();
  const total = Object.values(ZIPFORMER_FILES).reduce((s, f) => s + f.bytes, 0) + VAD_FILE.bytes;
  let loaded = 0;
  const tick = (n: number) => {
    loaded += n;
    onProgress?.(Math.min(loaded, total), total);
  };
  const [encoder, decoder, joiner, tokens] = await Promise.all([
    fetchFile(ZIPFORMER_FILES.encoder, cache, tick, signal),
    fetchFile(ZIPFORMER_FILES.decoder, cache, tick, signal),
    fetchFile(ZIPFORMER_FILES.joiner, cache, tick, signal),
    fetchFile(ZIPFORMER_FILES.tokens, cache, tick, signal),
  ]);
  let vad: Uint8Array | null = null;
  try {
    vad = await fetchFile({ ...VAD_FILE, bytes: 0 }, cache, tick, signal);
  } catch (e) {
    // The user cancelled: stop here. Any other failure: segment on energy instead.
    if (signal?.aborted || (e as Error)?.name === "AbortError") throw e;
    vad = null;
  }
  return { encoder, decoder, joiner, tokens: new TextDecoder().decode(tokens), vad };
}

/** Free the space (Settings / the dictation dialog). */
export async function deleteDictationModel(): Promise<void> {
  try {
    await caches.delete(DICTATION_CACHE);
  } catch {
    /* why: nothing to delete */
  }
}
