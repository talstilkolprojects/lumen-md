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
 * stored twice in a row. Plan 3.2: a version is stored as a compressed
 * delta from the one before (./historyDelta, loaded on demand), with the
 * full text every FULL_EVERY versions, so each document keeps its newest
 * 1000 versions in about the space 100 full copies took. Collab sessions
 * record here too (reason "collab", with the author). When the browser's
 * quota runs out the oldest snapshots of all documents go first and the
 * write is retried once; past 80 % of the quota listeners are warned.
 *
 * In an encrypted vault (plan 11.4) the content of each version is stored
 * sealed and whole — no deltas, which would carry the text in the clear (the
 * document's name is not sealed); nothing is recorded while the vault is
 * locked, and sealed versions read as absent until it is unlocked.
 *
 * History belongs to a vault (2.80, Codex P2 on #235): two vaults can both
 * have `notes/a.md`, and one must never see or restore the other's versions.
 * Every row is filed under the active vault's identity (`setHistoryVault`,
 * set by ./vault/location.ts on each switch). The first vault this code ever
 * saw keeps the empty identity, so the rows written before vaults had one
 * stay with it, unchanged; every other vault's rows are prefixed with
 * `lumen-vault:<id>|`. While no vault is open (start-up still restoring)
 * nothing is recorded and nothing is listed.
 */

import { log } from "../lib/logger";
import { lockedNotes } from "./lockedNotesRegistry";
import { forStore, fromStore, isSealedValue, type SealedValue } from "./vault/restStore";

const LABEL = "history";

export type SnapshotReason = "autosave" | "save" | "auto-backup" | "vault" | "close" | "restore" | "manual" | "collab" | "migrated" | "git-pull" | "merge";

export interface Snapshot {
  id: number;
  /** Document identity: workspace path, else display name. */
  name: string;
  content: string;
  timestamp: number;
  reason?: SnapshotReason;
  /** Who was editing (collab sessions). */
  author?: string;
  /** The vault identity it was listed from (set by `listSnapshots`, not stored). */
  vault?: string;
}

const DB_NAME = "lumen-history";
const STORE = "snapshots";
export const MAX_PER_DOC = 1000;
let maxPerDoc = MAX_PER_DOC;
/** Tests: a smaller per-document cap, so a cap test doesn't write 1000 versions. */
export function __setMaxPerDoc(n = MAX_PER_DOC): void {
  maxPerDoc = n;
}
/** Every FULL_EVERY-th version is stored as the full text; the rest as deltas (plan 3.2). */
export const FULL_EVERY = 20;
export const AUTOSAVE_EVERY_MS = 2 * 60_000;
const lastAutosave = new Map<string, number>();

/** The active vault's identity: "" for the first (legacy) vault, null while none is open. */
let vault: string | null = "";
const VAULT_PREFIX = "lumen-vault:";

/** Which vault's history is read and written from now on (null: none is open). */
export function setHistoryVault(id: string | null): void {
  vault = id;
}
export function getHistoryVault(): string | null {
  return vault;
}

/** The stored row name of `name` in vault `v`. */
function scoped(name: string, v: string): string {
  return v ? `${VAULT_PREFIX}${v}|${name}` : name;
}

/** `name` back out of a stored row name, when it belongs to vault `v`. */
function unscoped(stored: string, v: string): string | null {
  if (v) return stored.startsWith(`${VAULT_PREFIX}${v}|`) ? stored.slice(VAULT_PREFIX.length + v.length + 1) : null;
  return stored.startsWith(VAULT_PREFIX) ? null : stored;
}

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

/** A stored row: a full text, or a delta from the document's previous row. */
interface Row {
  id: number;
  name: string;
  timestamp: number;
  reason?: SnapshotReason;
  author?: string;
  /** Full text (every row written before plan 3.2 is one); sealed in an encrypted vault (plan 11.4). */
  content?: string | SealedValue;
  /** Delta from the row `base` (else from the previous row) of the same document. */
  delta?: Uint8Array | string;
  /** Id of the row the delta applies to. */
  base?: number;
}

type DeltaModule = typeof import("./historyDelta");
let deltaModule: Promise<DeltaModule> | null = null;
const deltas = () => (deltaModule ??= import("./historyDelta"));

/** A full row (plain or sealed), not a delta. */
const isFull = (r: Row) => r.content !== undefined;

/**
 * Sealed contents opened (plan 11.4). A row that cannot be opened (the
 * vault is locked) keeps its sealed content: it is still a full row, whose
 * text reads as absent. `sealed` holds the ids of the rows stored sealed.
 */
async function openRows(rows: Row[], sealed?: Set<number>): Promise<Row[]> {
  const out: Row[] = [];
  for (const r of rows) {
    if (!isSealedValue(r.content)) {
      out.push(r);
      continue;
    }
    sealed?.add(r.id);
    const text = await fromStore<string>(LABEL, r.content);
    out.push(typeof text === "string" ? { ...r, content: text } : r);
  }
  return out;
}

async function readRows(name: string, sealed?: Set<number>): Promise<Row[]> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readonly");
  const rows = (await promisify(tx.objectStore(STORE).index("name").getAll(name))) as Row[];
  return openRows(rows.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id), sealed);
}

/**
 * Every row's text, oldest first. A delta whose base is gone (a chain
 * broken by an old pruning) yields null and the chain resumes at the next
 * full row.
 */
async function reconstruct(rows: Row[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  const byId = new Map<number, string | null>();
  let cur: string | null = null;
  let mod: DeltaModule | null = null;
  for (const r of rows) {
    // A delta names its base; rows from another tab may interleave.
    const base = r.base !== undefined ? byId.get(r.base) ?? null : cur;
    if (typeof r.content === "string") cur = r.content;
    else if (r.content !== undefined) cur = null; // sealed, and the vault is locked
    else if (r.delta !== undefined && base !== null) {
      mod ??= await deltas();
      try {
        cur = mod.applyDelta(base, await mod.decodeDelta(r.delta));
      } catch {
        cur = null;
      }
    } else cur = null;
    byId.set(r.id, cur);
    out.push(cur);
  }
  return out;
}

/** Snapshots of one document of the active vault, newest first. */
export async function listSnapshots(name: string): Promise<Snapshot[]> {
  const v = vault;
  if (v === null) return [];
  const rows = await readRows(scoped(name, v));
  const texts = await reconstruct(rows);
  const out: Snapshot[] = [];
  rows.forEach((r, i) => {
    const content = texts[i];
    if (content !== null) out.push({ id: r.id, name, content, timestamp: r.timestamp, reason: r.reason, author: r.author, vault: v });
  });
  return out.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
}

/** Every document of the active vault that has history, with its newest snapshot time. */
export async function listDocuments(): Promise<Array<{ name: string; latest: number; count: number }>> {
  const v = vault;
  if (v === null) return [];
  const db = await openDB();
  const tx = db.transaction(STORE, "readonly");
  const rows = (await promisify(tx.objectStore(STORE).getAll())) as Row[];
  const by = new Map<string, { name: string; latest: number; count: number }>();
  for (const r of rows) {
    const name = unscoped(r.name, v);
    if (name === null) continue;
    const e = by.get(name) ?? { name, latest: 0, count: 0 };
    e.latest = Math.max(e.latest, r.timestamp);
    e.count++;
    by.set(name, e);
  }
  return [...by.values()].sort((a, b) => b.latest - a.latest);
}

/** Newest text per document, so a write needn't rebuild the chain. */
const latestText = new Map<string, { id: number; content: string }>();

/**
 * Delete `victims` (row ids) and make each affected document's oldest
 * remaining row a full text, so no remaining delta loses its base.
 */
async function dropRows(byDoc: Map<string, Row[]>, victims: Set<number>): Promise<void> {
  const rebased: Row[] = [];
  for (const rows of byDoc.values()) {
    const keep = rows.filter((r) => !victims.has(r.id));
    if (!keep.length || keep.length === rows.length) continue;
    // Kept deltas whose base goes: the first kept row, and any naming a victim.
    const orphans = keep.filter((r, i) => !isFull(r) && (i === 0 || (r.base !== undefined && victims.has(r.base))));
    if (!orphans.length) continue;
    // Rebuild only from the last full row before the first orphan — at the
    // cap that is at most FULL_EVERY rows, not the whole history.
    let from = rows.indexOf(orphans[0]);
    while (from > 0 && !isFull(rows[from])) from--;
    const span = rows.slice(from);
    const texts = await reconstruct(span);
    const docRebased: Row[] = [];
    let blocked = false;
    for (const r of orphans) {
      const text = texts[span.indexOf(r)];
      if (text === null) {
        victims.add(r.id);
        continue;
      }
      // The new full row is sealed in an encrypted vault (plan 11.4).
      const stored = await forStore(LABEL, text);
      if (stored === undefined) blocked = true;
      else docRebased.push({ ...r, content: stored, delta: undefined, base: undefined });
    }
    // Locked: a full row can't be written now, so this document keeps its rows.
    if (blocked) for (const r of rows) victims.delete(r.id);
    else rebased.push(...docRebased);
  }
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const id of victims) store.delete(id);
  for (const r of rebased) {
    const { delta: _drop, base: _base, ...full } = r;
    void _drop;
    void _base;
    store.put(full);
  }
  await done(tx);
}

/** One write per document at a time: a delta must be encoded against the row it follows. */
const writeQueue = new Map<string, Promise<unknown>>();
function serialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueue.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  writeQueue.set(name, tail);
  void tail.then(() => {
    if (writeQueue.get(name) === tail) writeQueue.delete(name);
  });
  return next;
}

function writeSnapshot(name: string, content: string, reason: SnapshotReason, now: number, author?: string): Promise<boolean> {
  return serialized(name, () => writeSnapshotNow(name, content, reason, now, author));
}

async function writeSnapshotNow(name: string, content: string, reason: SnapshotReason, now: number, author?: string): Promise<boolean> {
  // Sealing is asynchronous work outside IndexedDB, so it happens before the
  // write transaction opens (an await inside it would end the transaction).
  const stored = await forStore(LABEL, content);
  if (stored === undefined) return false; // an encrypted vault, locked: record nothing
  const rows = await readRows(name);
  const newest = rows[rows.length - 1];
  const backdated = !!newest && now < newest.timestamp;
  let prev: string | null = null;
  if (backdated) {
    // An imported backup older than the history: compare it with the
    // versions around its own time, not the newest — `A → B → A` keeps its
    // first `A` — and skip an exact re-import (same time, same text), so a
    // migration that runs again adds nothing.
    const texts = await reconstruct(rows);
    let before = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].timestamp === now && texts[i] === content) return false;
      if (rows[i].timestamp <= now) before = i;
    }
    if (before >= 0 && texts[before] === content) return false;
  } else if (newest) {
    const cached = latestText.get(name);
    prev = cached && cached.id === newest.id ? cached.content : (await reconstruct(rows))[rows.length - 1];
    if (prev === content) return false;
  }
  // A full text every FULL_EVERY versions bounds how many deltas a read applies.
  let sinceFull = 0;
  for (let i = rows.length - 1; i >= 0 && !isFull(rows[i]); i--) sinceFull++;
  const row: Omit<Row, "id"> = { name, timestamp: now, reason };
  if (author) row.author = author;
  // A backdated version (an imported backup older than the history) sorts
  // before rows it can't be a delta for: it is stored whole.
  // Sealed (an encrypted vault): always whole — a delta would hold the text in the clear.
  if (isSealedValue(stored)) row.content = stored;
  else if (prev === null || sinceFull >= FULL_EVERY - 1 || backdated) row.content = content;
  else {
    const mod = await deltas();
    const payload = await mod.encodeDelta(mod.diff(prev, content));
    // A delta bigger than the text itself (a rewrite) is stored as the text.
    if (mod.payloadBytes(payload) >= content.length) row.content = content;
    else {
      row.delta = payload;
      row.base = newest.id;
    }
  }
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  const req = tx.objectStore(STORE).add(row);
  await done(tx);
  if (!backdated) latestText.set(name, { id: req.result as number, content });
  if (rows.length + 1 > maxPerDoc) {
    const all = [...rows, { ...row, id: req.result as number } as Row].sort((x, y) => x.timestamp - y.timestamp || x.id - y.id);
    const victims = new Set(all.slice(0, all.length - maxPerDoc).map((r) => r.id));
    await dropRows(new Map([[name, all]]), victims);
  }
  void checkQuota();
  return true;
}

/** Stored bytes of one document's history in the active vault and the text bytes it represents (tests, the panel). */
export async function historyStats(name: string): Promise<{ versions: number; storedBytes: number; textBytes: number }> {
  const rows = vault === null ? [] : await readRows(scoped(name, vault));
  const texts = await reconstruct(rows);
  const enc = new TextEncoder();
  let stored = 0;
  let text = 0;
  rows.forEach((r, i) => {
    stored += typeof r.content === "string" ? enc.encode(r.content).length : r.delta === undefined ? 0 : typeof r.delta === "string" ? enc.encode(r.delta).length : r.delta.byteLength;
    text += texts[i] === null ? 0 : enc.encode(texts[i]!).length;
  });
  return { versions: rows.length, storedBytes: stored, textBytes: text };
}

/** Delete the oldest `fraction` of all snapshots (keeping each document's newest one). */
export async function pruneOldest(fraction = 0.25): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readonly");
  const rows = await openRows(((await promisify(tx.objectStore(STORE).getAll())) as Row[]).sort((a, b) => a.timestamp - b.timestamp || a.id - b.id));
  const byDoc = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byDoc.get(r.name) ?? [];
    list.push(r);
    byDoc.set(r.name, list);
  }
  const keep = new Set([...byDoc.values()].map((l) => l[l.length - 1].id));
  const victims = new Set(rows.filter((r) => !keep.has(r.id)).slice(0, Math.ceil(rows.length * fraction)).map((r) => r.id));
  const count = victims.size;
  await dropRows(byDoc, victims);
  return count;
}

// ── Quota ────────────────────────────────────────────────────────────────

export const QUOTA_WARN_RATIO = 0.8;
let lastQuotaCheck = 0;
type QuotaWarnListener = (usage: { usage: number; quota: number }) => void;
const quotaWarnListeners = new Set<QuotaWarnListener>();

/** Told (at most every ten minutes) when storage use passes 80 % of the quota. */
export function onQuotaWarning(fn: QuotaWarnListener): () => void {
  quotaWarnListeners.add(fn);
  return () => void quotaWarnListeners.delete(fn);
}

/** Check `navigator.storage.estimate()` after a write; never throws. */
export async function checkQuota(now = Date.now(), force = false): Promise<{ usage: number; quota: number } | null> {
  if (!force && now - lastQuotaCheck < 10 * 60_000) return null;
  lastQuotaCheck = now;
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return null;
    const u = { usage: est.usage ?? 0, quota: est.quota };
    if (u.usage / u.quota >= QUOTA_WARN_RATIO) for (const fn of quotaWarnListeners) fn(u);
    return u;
  } catch {
    return null;
  }
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
 * Returns whether a snapshot was written. `inVault` is the vault the text
 * came from (default: the active one), for a caller that captured it before
 * a switch could happen.
 */
export async function recordSnapshot(
  name: string,
  content: string,
  reason: SnapshotReason = "autosave",
  now = Date.now(),
  author?: string,
  inVault: string | null = vault,
): Promise<boolean> {
  if (!name || inVault === null || typeof indexedDB === "undefined") return false;
  // W5.11: an unlocked note with its own password is kept in history sealed.
  content = lockedNotes.atRest(name, content);
  name = scoped(name, inVault);
  // Typing autosaves every pause; keep one autosave snapshot per document
  // per AUTOSAVE_EVERY_MS so a document's 100 slots cover hours, not
  // minutes. Explicit saves, closes, restores and backups always record.
  if (reason === "autosave") {
    const last = lastAutosave.get(name) ?? 0;
    if (now - last < AUTOSAVE_EVERY_MS) return false;
    lastAutosave.set(name, now);
  }
  try {
    return await writeSnapshot(name, content, reason, now, author);
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    log.warn("[history] quota reached; pruning the oldest snapshots");
    await pruneOldest().catch(() => 0);
    try {
      return await writeSnapshot(name, content, reason, now, author);
    } catch (e2) {
      for (const fn of quotaListeners) fn(e2);
      throw e2;
    }
  }
}

/** Remove one document's history in the active vault (used when the note is deleted for good). */
export async function clearHistory(name: string): Promise<void> {
  const v = vault;
  if (v === null) return;
  name = scoped(name, v);
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const keys = (await promisify(store.index("name").getAllKeys(name))) as IDBValidKey[];
  for (const k of keys) store.delete(k);
  await done(tx);
  latestText.delete(name);
}

/**
 * Every version's content into (`seal`) or out of (`open`) the vault's
 * encryption (plan 11.4: turning it on, and off). Sealed versions are stored
 * whole, so a delta chain becomes full rows. Document by document; a row
 * that cannot be converted stays as it is. Only the active vault's history:
 * the encryption is that vault's (2.80).
 */
async function convertHistory(direction: "seal" | "open"): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  const v = vault;
  if (v === null) return 0;
  let n = 0;
  for (const { name } of await listDocuments()) {
    const sealed = new Set<number>();
    const rows = await readRows(scoped(name, v), sealed);
    const texts = await reconstruct(rows);
    const puts: Row[] = [];
    for (const [i, r] of rows.entries()) {
      const text = texts[i];
      if (text === null || sealed.has(r.id) === (direction === "seal")) continue;
      const content = direction === "seal" ? await forStore(LABEL, text) : text;
      if (content === undefined || (direction === "seal" && !isSealedValue(content))) continue;
      const { delta: _delta, base: _base, ...rest } = r;
      void _delta;
      void _base;
      puts.push({ ...rest, content });
    }
    if (!puts.length) continue;
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    for (const r of puts) tx.objectStore(STORE).put(r);
    await done(tx);
    n += puts.length;
  }
  latestText.clear();
  return n;
}

export const resealHistory = () => convertHistory("seal");
export const unsealHistory = () => convertHistory("open");

/** Tests: drop the cached connection (fake-indexeddb is reset between files). */
export function __resetHistoryDb(): void {
  dbPromise = null;
  lastAutosave.clear();
  latestText.clear();
  lastQuotaCheck = 0;
  maxPerDoc = MAX_PER_DOC;
  vault = "";
}
