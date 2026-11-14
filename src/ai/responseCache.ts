/**
 * Local cache of AI answers (IndexedDB, this device only).
 *
 * Only requests that opt in with `cache: true` are cached: deterministic
 * transformations of a given text (tags, translation, diagram, action
 * items, chart, outline). The key is a SHA-256 of the provider, the
 * effective model and every input that shapes the answer, so editing the
 * text, switching model or provider, or changing the prompt misses.
 *
 * Entries expire after TTL_MS; the store is capped at MAX_ENTRIES (oldest
 * dropped). Users can turn the cache off (`lumen.ai.cache` = "off") or
 * clear it from the palette.
 */
import { createStore, get, set, del, entries, clear, type UseStore } from "idb-keyval";

export const TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 500;

interface Entry {
  text: string;
  model: string;
  at: number;
}

let store: UseStore | null = null;
const db = () => (store ??= createStore("lumen-ai-cache", "answers"));

export function aiCacheEnabled(): boolean {
  try {
    return localStorage.getItem("lumen.ai.cache") !== "off";
  } catch {
    return true;
  }
}

export function setAiCacheEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem("lumen.ai.cache");
    else localStorage.setItem("lumen.ai.cache", "off");
  } catch {
    /* why: storage denied: the setting lasts for this session only */
  }
}

/** Stable hex SHA-256 of the request's identity. */
export async function cacheKey(parts: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getCached(key: string, now = Date.now()): Promise<Entry | null> {
  try {
    const e = await get<Entry>(key, db());
    if (!e) return null;
    if (now - e.at > TTL_MS) {
      await del(key, db());
      return null;
    }
    return e;
  } catch {
    return null; // IndexedDB unavailable (private mode…): no cache
  }
}

export async function putCached(key: string, text: string, model: string, now = Date.now()): Promise<void> {
  try {
    // An encrypted vault (plan 11.4): answers about its notes are not cached in the clear.
    const { storesMustSeal } = await import("../storage/vault/restStore");
    if (await storesMustSeal()) return;
    await set(key, { text, model, at: now } satisfies Entry, db());
    const all = await entries<string, Entry>(db());
    if (all.length > MAX_ENTRIES) {
      const oldest = all.sort((a, b) => a[1].at - b[1].at).slice(0, all.length - MAX_ENTRIES);
      for (const [k] of oldest) await del(k, db());
    }
  } catch {
    /* why: best-effort */
  }
}

export async function clearAiCache(): Promise<number> {
  try {
    const n = (await entries(db())).length;
    await clear(db());
    return n;
  } catch {
    return 0;
  }
}
