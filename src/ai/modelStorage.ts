/**
 * Storage used by the in-browser models, and clearing it (plan 5.7).
 *
 *   storageEstimate()       → { usage, quota, caches? } bytes, or null
 *   modelCacheNames()       → the Cache Storage entries the model libraries own
 *   clearModelCaches(kind)  → deletes them (and web-llm's IndexedDB copies)
 *
 * web-llm keeps weights, wasm and config in Cache Storage under
 * "webllm/model", "webllm/wasm" and "webllm/config" (or in IndexedDB
 * databases of the same names when its IndexedDB cache is on);
 * transformers.js keeps models in "transformers-cache" (and its wasm in a
 * cache of the same prefix). Nothing else is touched: the app's own
 * service-worker caches and the vault are not model data.
 */

export type ModelCacheKind = "webllm" | "transformers";

export interface StorageEstimateResult {
  usage: number;
  quota: number;
  /** Bytes in Cache Storage, where the browser reports it (Chromium). */
  caches?: number;
  /** navigator.storage.persisted(): the browser won't evict this origin under pressure. */
  persisted?: boolean;
}

const MATCH: Record<ModelCacheKind, RegExp> = {
  webllm: /^webllm\//,
  transformers: /^transformers/,
};

const WEBLLM_IDB = ["webllm/model", "webllm/wasm", "webllm/config"];

export function cacheKindOf(name: string): ModelCacheKind | null {
  if (MATCH.webllm.test(name)) return "webllm";
  if (MATCH.transformers.test(name)) return "transformers";
  return null;
}

export async function storageEstimate(): Promise<StorageEstimateResult | null> {
  try {
    const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!s?.estimate) return null;
    const e = (await s.estimate()) as StorageEstimate & { usageDetails?: { caches?: number } };
    const persisted = s.persisted ? await s.persisted().catch(() => undefined) : undefined;
    return {
      usage: e.usage ?? 0,
      quota: e.quota ?? 0,
      ...(typeof e.usageDetails?.caches === "number" ? { caches: e.usageDetails.caches } : {}),
      ...(persisted !== undefined ? { persisted } : {}),
    };
  } catch {
    return null;
  }
}

/** Model caches present on this origin, by library. */
export async function modelCacheNames(): Promise<Record<ModelCacheKind, string[]>> {
  const out: Record<ModelCacheKind, string[]> = { webllm: [], transformers: [] };
  try {
    if (typeof caches === "undefined") return out;
    for (const name of await caches.keys()) {
      const kind = cacheKindOf(name);
      if (kind) out[kind].push(name);
    }
  } catch {
    /* Cache Storage denied (private mode) */
  }
  return out;
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve();
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      // A tab still holding the database: deletion waits; don't hang the UI on it.
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Delete one library's model caches. The library's worker is unloaded
 * first (it keeps loaded models in memory), so the next run downloads again.
 * Returns how many caches were removed.
 */
export async function clearModelCaches(kind: ModelCacheKind): Promise<number> {
  // A loaded model is reused without consulting Cache Storage: unload it
  // first, so the next use really downloads again instead of running from
  // a worker that still holds the cleared weights.
  if (kind === "webllm") {
    const { unloadWebLlm } = await import("./webllmEngine");
    await unloadWebLlm().catch(() => undefined);
  } else {
    const { unloadTransformers } = await import("./transformersEngine");
    await unloadTransformers().catch(() => undefined);
  }
  const names = (await modelCacheNames())[kind];
  let removed = 0;
  for (const n of names) {
    try {
      if (await caches.delete(n)) removed++;
    } catch {
      /* already gone */
    }
  }
  if (kind === "webllm") await Promise.all(WEBLLM_IDB.map(deleteDb));
  return removed;
}

