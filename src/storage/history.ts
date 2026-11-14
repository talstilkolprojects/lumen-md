/**
 * One history store (MASTER_PLAN v3, T35).
 *
 * Every save path writes here: the debounced workspace autosave, the
 * explicit save, the 30-second auto-backup, the vault snapshot every ten
 * minutes and the flush when the page goes away. The Version History panel
 * reads it — it used to read a store nothing wrote to, so it was always
 * empty — and the auto-backup no longer writes `backups/` folders into the
 * vault, where they showed up in the file tree, in search and in the
 * embeddings index.
 *
 * Storage: IndexedDB `lumen-history` / `snapshots` (the store the panel
 * already used, so its old entries stay readable), keyed by the document's
 * identity (workspace path, else its name). Identical content is never
 * stored twice in a row; each document keeps its newest 100 snapshots; when
 * the browser's quota runs out the oldest snapshots of all documents go
 * first and the write is retried once.
 */

import { log } from "../lib/logger";

export type SnapshotReason = "autosave" | "save" | "auto-backup" | "vault" | "close" | "restore" | "manual" | "git-pull";

export interface Snapshot {
  id: number;
  /** Document identity: workspace path, else display name. */
  name: string;
  content: string;
  timestamp: number;
  reason?: SnapshotReason;
}

const DB_NAME = "lumen-history";
const STORE = "snapshots";
export const MAX_PER_DOC = 100;
export const AUTOSAVE_EVERY_MS = 2 * 60_000;
const lastAutosave = new Map<string, number>();

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("name", "name", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading: let it, reopen next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException("aborted", "AbortError"));
  });
}

/** Identity a document's history is filed under. */
export function historyKey(doc: { workspaceName?: string | null; name: string }): string {
  return doc.workspaceName || doc.name;
}

export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/** Snapshots of one document, newest first. */
export async function listSnapshots(name: string): Promise<Snapshot[]> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readonly");
  const rows = (await promisify(tx.objectStore(STORE).index("name").getAll(name))) as Snapshot[];
  return rows.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
}

/** Every document that has history, with its newest snapshot time. */
export async function listDocuments(): Promise<Array<{ name: string; latest: number; count: number }>> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readonly");
  const rows = (await promisify(tx.objectStore(STORE).getAll())) as Snapshot[];
  const by = new Map<string, { name: string; latest: number; count: number }>();
  for (const r of rows) {
    const e = by.get(r.name) ?? { name: r.name, latest: 0, count: 0 };
    e.latest = Math.max(e.latest, r.timestamp);
    e.count++;
    by.set(r.name, e);
  }
  return [...by.values()].sort((a, b) => b.latest - a.latest);
}

async function writeSnapshot(name: string, content: string, reason: SnapshotReason, now: number): Promise<boolean> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const existing = ((await promisify(store.index("name").getAll(name))) as Snapshot[]).sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
  if (existing[0]?.content === content) {
    await done(tx);
    return false;
  }
  store.add({ name, content, timestamp: now, reason });
  for (const old of existing.slice(MAX_PER_DOC - 1)) store.delete(old.id);
  await done(tx);
  return true;
}

/** Delete the oldest `fraction` of all snapshots (keeping each document's newest one). */
export async function pruneOldest(fraction = 0.25): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const rows = ((await promisify(store.getAll())) as Snapshot[]).sort((a, b) => a.timestamp - b.timestamp);
  const newest = new Map<string, number>();
  for (const r of rows) newest.set(r.name, r.id);
  const keep = new Set(newest.values());
  const victims = rows.filter((r) => !keep.has(r.id)).slice(0, Math.ceil(rows.length * fraction));
  for (const v of victims) store.delete(v.id);
  await done(tx);
  return victims.length;
}

type QuotaListener = (e: unknown) => void;
const quotaListeners = new Set<QuotaListener>();
/** Told when a write hit the quota (after pruning and one retry failed too). */
export function onHistoryQuota(fn: QuotaListener): () => void {
  quotaListeners.add(fn);
  return () => void quotaListeners.delete(fn);
}

/**
 * Record a snapshot. Skips content identical to the document's newest
 * snapshot. On a quota error, prunes the oldest quarter and retries once;
 * if that fails too, listeners are told and the error is rethrown.
 * Returns whether a snapshot was written.
 */
export async function recordSnapshot(name: string, content: string, reason: SnapshotReason = "autosave", now = Date.now()): Promise<boolean> {
  if (!name || typeof indexedDB === "undefined") return false;
  // Typing autosaves every pause; keep one autosave snapshot per document
  // per AUTOSAVE_EVERY_MS so a document's 100 slots cover hours, not
  // minutes. Explicit saves, closes, restores and backups always record.
  if (reason === "autosave") {
    const last = lastAutosave.get(name) ?? 0;
    if (now - last < AUTOSAVE_EVERY_MS) return false;
    lastAutosave.set(name, now);
  }
  try {
    return await writeSnapshot(name, content, reason, now);
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    log.warn("[history] quota reached; pruning the oldest snapshots");
    await pruneOldest().catch(() => 0);
    try {
      return await writeSnapshot(name, content, reason, now);
    } catch (e2) {
      for (const fn of quotaListeners) fn(e2);
      throw e2;
    }
  }
}

/** Remove one document's history (used when the note is deleted for good). */
export async function clearHistory(name: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const keys = (await promisify(store.index("name").getAllKeys(name))) as IDBValidKey[];
  for (const k of keys) store.delete(k);
  await done(tx);
}

/** Tests: drop the cached connection (fake-indexeddb is reset between files). */
export function __resetHistoryDb(): void {
  dbPromise = null;
  lastAutosave.clear();
}
