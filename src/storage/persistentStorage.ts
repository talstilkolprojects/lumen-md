/**
 * Ask the browser to keep this origin's storage (OPFS, IndexedDB,
 * localStorage) out of eviction.
 *
 * Without `navigator.storage.persist()` the whole vault is "best-effort"
 * storage: Chromium evicts it under disk pressure and Safari deletes it
 * after seven days without a visit. One call at startup is all it takes;
 * Chromium grants it silently for installed PWAs and engaged sites,
 * Firefox asks the user once, Safari grants it to installed apps.
 */

import { log } from "../lib/logger";

export type PersistenceStatus = "persisted" | "denied" | "unsupported";

type StorageLike = Pick<StorageManager, "persist" | "persisted">;

let lastStatus: PersistenceStatus | null = null;

/** Result of the last request, for the status bar / doctor. */
export function persistenceStatus(): PersistenceStatus | null {
  return lastStatus;
}

export interface StorageState {
  /** null when the browser has no persist() API. */
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
}

/** What the Version History panel shows: persisted or not, and how full. Never throws. */
export async function storageState(
  storage: Partial<Pick<StorageManager, "persisted" | "estimate">> | undefined = typeof navigator !== "undefined" ? navigator.storage : undefined,
): Promise<StorageState> {
  let persisted: boolean | null = null;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (storage && typeof storage.persisted === "function") persisted = await storage.persisted();
  } catch {
    persisted = false;
  }
  try {
    const est = storage && typeof storage.estimate === "function" ? await storage.estimate() : undefined;
    if (est?.quota) {
      usage = est.usage ?? 0;
      quota = est.quota;
    }
  } catch {
    /* no estimate */
  }
  return { persisted, usage, quota };
}

/**
 * Request durable storage. Safe to call more than once: an origin that
 * is already persisted is reported without a second prompt. Never throws.
 */
export async function requestPersistentStorage(
  storage: StorageLike | undefined = typeof navigator !== "undefined" ? navigator.storage : undefined,
): Promise<PersistenceStatus> {
  if (!storage || typeof storage.persist !== "function") {
    lastStatus = "unsupported";
    return lastStatus;
  }
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) {
      lastStatus = "persisted";
      return lastStatus;
    }
    lastStatus = (await storage.persist()) ? "persisted" : "denied";
  } catch (err) {
    log.warn("[storage] persist() failed", (err as Error).message);
    lastStatus = "denied";
  }
  if (lastStatus === "denied") log.warn("[storage] durable storage not granted; the vault may be evicted");
  return lastStatus;
}
