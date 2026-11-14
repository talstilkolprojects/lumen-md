/**
 * The workspace index: search, backlinks, the tags panel and the file
 * tree read the vault through it.
 *
 * Plan 8.4 (large vault): the index itself — lower-cased text, Hebrew
 * comparison forms, the backlinks map — lives in a Web Worker
 * (./vaultIndex.worker.ts over ./vaultIndexCore.ts), so a query over
 * 10,000 notes never blocks typing. This module stays on the main thread:
 * it reads notes through the VaultBackend (./vault) and keeps the worker in
 * step, one changed file at a time.
 *
 * What keeps it fresh, cheapest first:
 *   - vault events (`watchVault`): a write marks that file dirty, a delete
 *     or a rename moves / drops its entries without reading anything;
 *   - `lumen-workspace-changed` "content" events mark the saved files dirty;
 *   - a structural event (or every REVALIDATE_MS) re-lists the vault and
 *     re-reads only the files whose mtime changed or that appeared — never
 *     the whole vault again after the first build.
 *
 * W6.36: with a snapshot, the open does not wait for the vault's listing
 * (10,000 files' mtimes are 10,000 calls into the browser). It trusts the
 * snapshot, which records every note's path and mtime, and checks it
 * against a listing started at the same time (`cache.verify`). What changed
 * while the app was closed comes in like any other change. Every query that
 * answers from the notes' text (search, backlinks, related, tasks, the texts
 * themselves) waits for that check, so its first answer is already right;
 * `indexedFiles()` holds the snapshot's summaries until then.
 */

import { WORKSPACE_CHANGED, changeOf } from "./workspaceEvents";
import { isOPFSAvailable, type WorkspaceEntry } from "./workspace";
import { getVaultBackend, refreshVaultEncryption, unwrapVaultBackend, vaultEncryptionReady, watchVault, type VaultEvent } from "./vault";
import type { IndexEngine } from "./vaultIndexProtocol";
import { log } from "../lib/logger";
import { scheduleIdle } from "../lib/idle";
import { dropSnapshot } from "./indexSnapshot";
import type { SnapshotKeys } from "./snapshotSeal";

export type { BacklinkHit, SearchHit } from "./vaultIndexCore";
import { cache, type IndexedFile, type ListingWatch, type ReadNote } from "./workspaceIndexState";
import { diffListing, fillingEncrypted, indexable, indexFile, listNotes, mapLimit, nameOf, recordVault, under, upsertAll, UPSERT_BATCH, type IndexOp, type ToRead } from "./workspaceIndexRead";
import { CheckTimeoutError, wakeBuilds, wakeOnUnlockOrMove, withDeadline } from "./workspaceIndexWait";
export type { IndexedFile } from "./workspaceIndexState";
export { VAULT_ID_PATH } from "./workspaceIndexRead";
export { findBacklinks, indexChecked, indexedFiles, indexedNotes, indexedNoteText, indexStats, indexVersion, queryVaultTasks, relatedInIndex, searchWorkspace, workspaceTree } from "./workspaceIndexQueries";

/** Bumped by a reset (tests): work of an earlier index must not touch the new one. */
let epoch = 0;
/** Bumped only by `__resetWorkspaceIndex` (tests): a run of the index before it stops retrying. */
let resets = 0;

/** Until the check of the snapshot the index opened from is done (at once when there is none). */
export async function verified(): Promise<void> {
  while (cache.verify) await cache.verify;
}

/**
 * For every query that answers from the notes (review 14.11 T2): the index
 * is open and checked against the vault. A failed check drops the trusted
 * notes, and the build that follows waits for the listing, so a query either
 * answers from the vault as it is or fails; never from an unchecked snapshot.
 */
export async function checkedIndex(force = false): Promise<void> {
  await ensureIndex(force);
  await verified();
  if (!cache.builtAt) await ensureIndex();
}

/**
 * Review 15 V3: how long a view that lists notes (`ensureIndex(false, {
 * checked: true })`) waits for the check before it goes on with what
 * `indexedFiles()` gives while unchecked: nothing. It re-derives when the
 * check ends (`indexVersion()`). Text queries keep waiting for the check.
 */
export const VIEW_CHECK_WAIT_MS = 1_000;
/**
 * V3: a check whose listing has not settled after this long counts as
 * failed: the trusted notes go and the next use reads the vault (T2). A
 * 10,000-note OPFS listing takes 2–10 s on a slow machine.
 */
export const CHECK_TIMEOUT_MS = 60_000;
/** The bounds in force (tests shorten them with `__setCheckBounds`). */
let checkTimeoutMs = CHECK_TIMEOUT_MS;
let viewCheckWaitMs = VIEW_CHECK_WAIT_MS;

/** The listing being watched (one at a time: the last one started, or the kept one). */
let watching: ListingWatch | null = null;

/** Y1/Y2: a change in the vault, as the listing being watched sees it. */
function watchChange(path: string | null): void {
  if (!watching) return;
  if (path === null) {
    watching.reusable = false;
    cache.pendingListing = null;
  } else watching.dirty.add(path);
}

/** For a view that lists notes (V3): the index open and checked, or, after VIEW_CHECK_WAIT_MS, open and still unchecked (it then lists none). */
async function checkedView(force: boolean): Promise<void> {
  // Review 17 W2: after a failed check the rebuild waits for a fresh listing; a view waits for it as long as for a
  // check, then lists what an index being rebuilt holds (nothing).
  if (cache.distrust) return bounded(checkedIndex(force));
  await ensureIndex(force);
  if (!cache.verify) return checkedIndex();
  return bounded(checkedIndex());
}

/** `p`, waited for at most VIEW_CHECK_WAIT_MS; a rejection inside that time is passed on. */
async function bounded(p: Promise<void>): Promise<void> {
  p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, viewCheckWaitMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forget everything the index holds, on this thread and in the worker:
 * on lock (T4), on a vault switch (T1) and after a failed check (T2). The
 * next use builds again, from the sealed snapshot when there is one.
 */
function dropIndex(): void {
  epoch++;
  cache.byPath = new Map();
  cache.builtAt = 0;
  cache.checkedAt = 0;
  cache.verify = null;
  cache.dirty.clear();
  cache.ops = [];
  cache.stale = false;
  cache.listing = null;
  cache.filledEncrypted = false;
  cache.filledVault = null;
  cache.pendingListing = null;
  watching = null;
  cache.version++;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  snapshotGen++;
  void engine?.then((e) => e.clear()).catch(() => undefined);
  wakeBuilds();
}

/** U1/U3: the index was dropped, or another vault is active, since `at`: what is being built is not this index. */
function moved(at: number, vault: string): boolean {
  return at !== epoch || snapshotVault() !== vault;
}


/**
 * Not every change reaches the index as an event (another tab writing
 * the same OPFS, a folder edited behind a watcher's back): at most this
 * often, a use of the index re-lists the vault and re-reads only the
 * files whose mtime changed — or that appeared.
 */
export const REVALIDATE_MS = 30_000;

// ── The engine (worker, or this thread) ─────────────────────────────────

let engine: Promise<IndexEngine> | null = null;
let engineOverride: (() => IndexEngine) | null = null;

async function createEngine(): Promise<IndexEngine> {
  if (engineOverride) return engineOverride();
  if (typeof Worker !== "undefined") {
    try {
      const w = new Worker(new URL("./vaultIndex.worker.ts", import.meta.url), { type: "module" });
      // The message plumbing is a lazy chunk too: nothing of the index is on the startup path.
      const { workerEngine } = await import("./vaultIndexProtocol");
      return workerEngine(w);
    } catch (err) {
      log.warn("vault index worker unavailable; indexing on the main thread", err);
    }
  }
  return localIndexEngine();
}

/** The core is only loaded on the main thread when there is no worker. */
async function localIndexEngine(): Promise<IndexEngine> {
  const { VaultIndex, localEngine } = await import("./vaultIndexLocal");
  return localEngine(new VaultIndex());
}

export function getEngine(): Promise<IndexEngine> {
  return (engine ??= createEngine());
}

/**
 * Run `fn` on the engine. If the worker died, switch to an in-thread
 * engine, give it every indexed note again, and retry once.
 */
export async function withEngine<T>(fn: (e: IndexEngine) => Promise<T>): Promise<T> {
  const current = getEngine();
  // Review 29 Z5: the vault and the epoch this request belongs to, for the refill below.
  const at = epoch;
  const vault = snapshotVault();
  const e = await current;
  try {
    return await fn(e);
  } catch (err) {
    // W6.36: a request to an engine that was replaced meanwhile (a reset) is
    // not a dead worker: it must not swap the new engine for a local one.
    if (e.kind !== "worker" || engine !== current) throw err;
    log.warn("vault index worker failed; indexing on the main thread", err);
    e.dispose();
    const local = await localIndexEngine();
    engine = Promise.resolve(local);
    // The text died with the worker (W2.22: this thread keeps summaries only):
    // fill the new index from the snapshot, reading only what it lacks.
    // Z5: the refill reads from the vault active now; once the vault or the epoch moved (a switch, a lock, a drop),
    // what it read is another index's: it stops posting, and the request is not retried.
    const stale = () => moved(at, vault);
    const filled = await fillEngine(local, [...cache.byPath.values()], stale);
    if (stale()) {
      // Review 33 Z7: when the epoch moved, the drop already cleared the engine, and a newer build may have filled
      // it since: leave it. When only the vault moved (no drop yet), drop now, so the next use builds that vault.
      if (at === epoch) dropIndex();
      throw err;
    }
    for (const [path, f] of filled) cache.byPath.set(path, f);
    return fn(local);
  }
}

// ── Keeping the index in step ───────────────────────────────────────────

// ── W2.22: the index survives a restart (./indexSnapshot.ts) ─────────────

/** How the last full build got its notes: from the snapshot or by reading them. */
export const snapshotCounters = { fromSnapshot: 0, read: 0 };
const SNAPSHOT_DELAY_MS = 5_000;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotReset: Promise<void> = Promise.resolve();
let snapshotGen = 0;

/**
 * Review 19 Y2 / R1: which vault is active, within this session. A backend's
 * `id` is its kind ("folder", "desktop", "opfs"), the same for two folders;
 * the backend object under the encryption gate is one per vault, so each
 * gets its own token. The T1/U1 guards and the kept listing (W1) use it.
 */
const vaultTokens = new WeakMap<object, string>();
let tokenSeq = 0;
function snapshotVault(): string {
  try {
    const inner = unwrapVaultBackend(getVaultBackend());
    let t = vaultTokens.get(inner);
    if (!t) vaultTokens.set(inner, (t = `${inner.id}#${++tokenSeq}`));
    return t;
  } catch {
    return "default";
  }
}

/** The vault the index last saw active (review 22 Z1): any change of it is a vault switch. */
let lastVault: string | null = null;

/**
 * Review 22 Z1: on every vault switch, whatever the index holds goes: the
 * engine's texts, the summaries, `filledVault`/`filledEncrypted` and any
 * scheduled save (dropIndex bumps `snapshotGen`). Not only when an index was
 * filled: a stray refresh may have filled the engine with `filledVault` null.
 */
function noteVaultSwitch(): void {
  const now = snapshotVault();
  if (lastVault !== null && lastVault !== now) dropIndex();
  lastVault = now;
}

/**
 * Whether there is a snapshot now, and how it is kept. A plain vault: in
 * the clear (`{}`). An encrypted, unlocked vault (plan 11.4): sealed and
 * signed in the worker with the snapshot subkeys (W6.36, ./snapshotSeal.ts).
 * A locked vault: none (null) — nothing is written, and the one on disk
 * stays for the next unlock.
 *
 * Review 12.11 S1: a vault that is unavailable right now (a folder
 * disconnected, a vault closing) can't say whether it is encrypted, so it
 * gets none either; and an index filled from an encrypted vault
 * (`cache.filledEncrypted`) is never saved in the clear, whatever the vault
 * says later.
 */
async function snapshotMode(): Promise<{ keys?: SnapshotKeys } | null> {
  try {
    const backend = getVaultBackend();
    if (!backend.available()) return null;
    // T1: only an index filled from this very vault is this vault's snapshot (a dropped index has none).
    if (cache.filledVault !== snapshotVault()) return null;
    let state = await vaultEncryptionReady();
    if (state === "none") {
      if (cache.filledEncrypted) return null;
      // T3: before anything is written in the clear, look for the encryption header again: another tab may have
      // turned encryption on, and this tab's gate would still say "plain".
      refreshVaultEncryption();
      state = await vaultEncryptionReady();
      if (state === "none") return {};
    }
    if (state !== "unlocked") return null;
    const { restSnapshotKeys } = await import("./vault/restStore");
    const keys = restSnapshotKeys();
    return keys ? { keys } : null;
  } catch {
    return null;
  }
}

/**
 * Save the snapshot in the mode the vault calls for now. T6: a plain save
 * that lands after encryption was turned on (it was already queued in the
 * worker when the conversion dropped the snapshot) is dropped again.
 */
async function saveSnapshotNow(): Promise<void> {
  const gen = snapshotGen;
  const at = epoch;
  const vault = snapshotVault();
  const current = () => gen === snapshotGen && !moved(at, vault);
  const mode = await snapshotMode();
  // Z1: a switch, a drop or a new build since this save was asked for: what the engine holds is not what was meant.
  if (!mode || !current()) return;
  // Z5: checked again right before the write, inside the request: a worker death refills the engine first, and a
  // switch during that refill must not reach the record.
  const key = cache.recordVault;
  await withEngine(async (eng) => {
    if (current()) await eng.saveSnapshot(key, mode.keys);
  });
  if (!mode.keys) {
    const now = await snapshotMode();
    if (!now || now.keys) await dropSnapshot();
  }
}

/** Write the snapshot a little after the last change, while idle (never on the typing path). */
function scheduleSnapshot(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  const gen = snapshotGen;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    scheduleIdle(() => {
      if (gen !== snapshotGen) return;
      void saveSnapshotNow().catch(() => {
        // why: a snapshot save is best effort; the next idle save or the next open tries again
      });
    });
  }, SNAPSHOT_DELAY_MS);
}

/**
 * Fill an empty index with `entries`: the worker takes every note the
 * snapshot holds unchanged; the others are read here, their text sent to the
 * index and dropped. Returns the summaries.
 */
async function fillEngine(
  eng: IndexEngine,
  entries: { path: string; name: string; modified: number; size?: number }[],
  /** U3: stop posting to the engine once this says the index moved on. */
  stale: () => boolean = () => false,
): Promise<Map<string, IndexedFile>> {
  const out = new Map<string, IndexedFile>();
  const mode = await snapshotMode();
  if (stale()) return out;
  const restored = mode ? await eng.restoreSnapshot(cache.recordVault, entries.map((e) => ({ path: e.path, name: e.name, modified: e.modified, size: e.size })), mode.keys) : [];
  for (const r of restored) out.set(r.path, r);
  snapshotCounters.fromSnapshot += restored.length;
  let batch: ReadNote[] = [];
  await mapLimit(
    entries.filter((e) => !out.has(e.path)),
    16,
    async (e) => {
      if (stale()) return;
      const r = await indexFile(e);
      snapshotCounters.read++;
      if (!r) return;
      out.set(e.path, r.file);
      batch.push(r);
      if (batch.length >= UPSERT_BATCH) {
        const send = batch;
        batch = [];
        if (!stale()) await upsertAll(eng, send);
      }
    },
  );
  if (batch.length && !stale()) await upsertAll(eng, batch);
  return out;
}

/**
 * Build the whole index (first use, or `ensureIndex(true)`). `trust`: the
 * first open may open from the snapshot without waiting for the listing
 * (W6.36); a forced rebuild waits for it, as before.
 */
async function build(trust = false): Promise<void> {
  if (!isOPFSAvailable()) return;
  await verified();
  const at = epoch;
  const vault = snapshotVault();
  // T4: a locked vault is not read; the open continues on unlock (from its sealed snapshot). U2: the wait also
  // ends on a drop or a vault switch, and then this build gives way: the next ensureIndex builds the active vault.
  for (;;) {
    const wait = wakeOnUnlockOrMove();
    if ((await vaultEncryptionReady().catch(() => "none")) !== "locked") {
      wait.cancel();
      break;
    }
    await wait.woke;
    if (moved(at, vault)) return;
  }
  // Z1: no save scheduled for what the engine held before, and an empty engine, before this build labels the index.
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  snapshotGen++;
  await withEngine((eng) => eng.clear());
  if (moved(at, vault)) return;
  // Clear before reading: a change announced while the build runs (it may
  // have read that file already) must survive for the next ensureIndex.
  cache.dirty.clear();
  cache.ops = [];
  cache.stale = false;
  snapshotCounters.fromSnapshot = 0;
  snapshotCounters.read = 0;
  await snapshotReset;
  // Fixed when the index is filled (S1); it only ever turns on until the next build.
  cache.filledEncrypted = await fillingEncrypted();
  cache.recordVault = await recordVault();
  if (moved(at, vault)) return;
  cache.filledVault = vault;
  if (cache.distrust) trust = false;
  const mode = await snapshotMode();
  const restored = trust && mode
    ? await withEngine(async (eng) => {
        await eng.clear();
        // U3: a lock (or a switch) during the clear: nothing more is posted for this index.
        if (moved(at, vault)) return [];
        return eng.restoreSnapshot(cache.recordVault, null, mode.keys);
      })
    : [];
  // The listing starts once the snapshot is open (W6.36): the open does not wait for it, nor share the CPU with it.
  if (moved(at, vault)) return discard();
  // W1: the listing a timed-out check was waiting on, when it is this vault's.
  const pending = cache.pendingListing?.vault === vault ? cache.pendingListing : null;
  cache.pendingListing = null;
  const listing = pending?.listing ?? listNotes(false);
  listing.catch(() => undefined);
  // Y1: what changes while this listing runs (a fresh one), so it can be reused after a timeout.
  const since: ListingWatch = pending?.since ?? { dirty: new Set(), reusable: true };
  watching = since;
  if (restored.length) {
    cache.byPath = new Map(restored.map((r) => [r.path, r] as const));
    snapshotCounters.fromSnapshot = restored.length;
    cache.builtAt = cache.checkedAt = Date.now();
    cache.version++;
    // Asked now, so the answer comes right after the worker has indexed the restored texts.
    const body = withEngine((eng) => eng.snapshotBody());
    body.catch(() => undefined);
    const v = verifySnapshot(listing, body, epoch, since).finally(() => {
      if (cache.verify === v) cache.verify = null;
    });
    cache.verify = v;
    return;
  }
  const list = await listing;
  const next = new Map<string, IndexedFile>();
  await withEngine(async (eng) => {
    await eng.clear();
    for (const [path, f] of await fillEngine(eng, list, () => moved(at, vault))) next.set(path, f);
  });
  // U1: the vault changed while its notes were read (they may be another vault's): thrown away.
  if (moved(at, vault)) return discard();
  if (watching === since) watching = null;
  // Y1: notes saved since the reused listing was taken are read again (the next round of ensureIndex).
  for (const p of since.dirty) if (indexable(p)) cache.dirty.add(p);
  cache.distrust = false;
  cache.byPath = next;
  scheduleSnapshot();
  cache.builtAt = cache.checkedAt = Date.now();
  cache.version++;
}

/** A build whose index moved on: whatever it already posted leaves the engine (U3). */
function discard(): void {
  void engine?.then((e) => e.clear()).catch(() => undefined);
}

/**
 * W6.36: the notes the index opened with from the snapshot, checked against
 * the vault's listing: a note gone is dropped, a note new or with another
 * mtime is read — every note, if the worker refused the snapshot's texts
 * (`body`) after it opened from its manifest. Never throws: when the vault can't be listed, the next use
 * of the index lists it again.
 */
async function verifySnapshot(listing: Promise<WorkspaceEntry[]>, body: Promise<{ refused: boolean }>, at: number, since: ListingWatch): Promise<void> {
  try {
    // V3: a listing that never settles fails the check (closed) instead of holding every query.
    const [list, texts] = await withDeadline(Promise.all([listing, body]), checkTimeoutMs);
    if (at !== epoch) return;
    const indexOps: IndexOp[] = [];
    const toRead = new Map<string, ToRead>();
    // The texts were refused after the manifest was taken: every note is read from the vault.
    if (texts.refused) for (const f of cache.byPath.values()) f.modified = 0;
    diffListing(list, indexOps, toRead);
    let fromSnapshotLost = indexOps.length;
    for (const path of toRead.keys()) if (cache.byPath.has(path)) fromSnapshotLost++;
    snapshotCounters.fromSnapshot -= fromSnapshotLost;
    snapshotCounters.read += toRead.size;
    await applyChanges(indexOps, toRead, at);
    if (watching === since) watching = null;
    // T7: the summaries are shown from now on; views that cached what they derived from none re-derive.
    if (at === epoch) cache.version++;
  } catch (err) {
    if (at !== epoch) return;
    log.warn("vault index: checking the snapshot against the vault failed; it is checked again on next use", err);
    // T2: fail closed. The trusted notes go, and the next open waits for the listing.
    dropIndex();
    cache.distrust = true;
    // W1: a listing that is only slow is not started again: the rebuild waits for this one, unless the vault's
    // structure changed meanwhile (Y2); what was saved since it started is read again after it (Y1).
    if (err instanceof CheckTimeoutError && since.reusable) {
      cache.pendingListing = { vault: snapshotVault(), listing, since };
      watching = since;
    }
  }
}

/**
 * C3 / 8.4: apply what changed since the last use — moves and deletes
 * without reading, then re-read only the dirty files (plus, after a
 * structural change, the ones whose mtime differs from the listing).
 */
async function refresh(): Promise<void> {
  // After the snapshot's check (W6.36): changes apply in the order they happened.
  await verified();
  // Review 29 Z6: the epoch this refresh belongs to, taken before its listing: a drop during it stops it.
  const at = epoch;
  // Z1: an index that isn't built (dropped, or a build that gave way) is never filled by a refresh: it would hold
  // notes no build labelled. The next ensureIndex builds it.
  if (!cache.builtAt) return;
  // W2.22: the index holds the text, so moves happen inside it; this list
  // keeps removes and moves in the order they happened.
  const indexOps: IndexOp[] = [];
  // In order: deleting A/x.md and then moving A to B must not bring x back as B/x.md.
  for (const op of cache.ops.splice(0)) {
    if (op.type === "remove") {
      for (const p of under(op.path)) {
        cache.byPath.delete(p);
        indexOps.push({ kind: "remove", path: p });
      }
      continue;
    }
    const { from, to } = op;
    for (const p of under(from)) {
      const f = cache.byPath.get(p)!;
      cache.byPath.delete(p);
      const dest = to + p.slice(from.length);
      if (!indexable(dest)) {
        indexOps.push({ kind: "remove", path: p });
        continue;
      }
      cache.byPath.set(dest, { ...f, path: dest, name: nameOf(dest) });
      indexOps.push({ kind: "move", from: p, to: dest, name: nameOf(dest) });
    }
    // Moved out of a hidden folder (e.g. restored from the trash): read it.
    if (indexable(to) && !under(to).length) cache.stale = true;
  }

  const toRead = new Map<string, ToRead>();
  if (cache.stale || Date.now() - cache.checkedAt >= REVALIDATE_MS) {
    const structural = cache.stale;
    cache.stale = false;
    cache.checkedAt = Date.now();
    diffListing(await listNotes(structural), indexOps, toRead);
  }
  const dirty = [...cache.dirty];
  cache.dirty.clear();
  for (const path of dirty) {
    if (!indexable(path) || toRead.has(path)) continue;
    toRead.set(path, { path, name: cache.byPath.get(path)?.name ?? nameOf(path), modified: null });
  }
  if (at !== epoch) return;
  await applyChanges(indexOps, toRead, at);
}

/** Read `toRead`, then send the removes, moves and new texts to the index, in order. Nothing when the index was reset meanwhile. */
async function applyChanges(indexOps: IndexOp[], toRead: Map<string, ToRead>, at: number): Promise<void> {
  const toWrite: ReadNote[] = [];
  // T1: notes read from an encrypted vault (or one that can't tell) make this index one that is never saved in the clear.
  if (toRead.size && !cache.filledEncrypted && (await fillingEncrypted())) cache.filledEncrypted = true;
  await mapLimit([...toRead.values()], 16, async (e) => {
    const r = await indexFile(e);
    if (at !== epoch) return;
    if (r) {
      cache.byPath.set(e.path, r.file);
      toWrite.push(r);
    } else if (cache.byPath.delete(e.path)) indexOps.push({ kind: "remove", path: e.path });
  });
  if (at !== epoch || (!indexOps.length && !toWrite.length)) return;
  // Views that cache what they derive from the index (wiki-link completion) re-derive.
  cache.version++;
  scheduleSnapshot();
  await withEngine(async (eng) => {
    // Runs of removes and of moves, each as one request, in order.
    for (let i = 0; i < indexOps.length; ) {
      // U3: checked right before each post: a lock or a switch meanwhile leaves the cleared engine alone.
      if (at !== epoch) return;
      const kind = indexOps[i].kind;
      let j = i;
      while (j < indexOps.length && indexOps[j].kind === kind) j++;
      const run = indexOps.slice(i, j);
      if (kind === "remove") await eng.remove(run.map((o) => (o as { path: string }).path));
      else await eng.move(run as { from: string; to: string; name: string }[]);
      i = j;
    }
    // Only what the vault holds now; last read wins.
    const latest = new Map(toWrite.filter((r) => cache.byPath.get(r.file.path) === r.file).map((r) => [r.file.path, r]));
    if (latest.size && at === epoch) await upsertAll(eng, [...latest.values()]);
  });
}

function pendingChanges(): boolean {
  return cache.stale || cache.dirty.size > 0 || cache.ops.length > 0;
}

/**
 * Open the index (build it on first use, apply what changed since). It
 * resolves once the index is open: from a trusted snapshot, before that
 * snapshot is checked against the vault (W6.36). `checked`: also wait for
 * that check — for a view that lists `indexedFiles()` (T7: until the check
 * it lists none).
 */
export async function ensureIndex(force = false, opts: { checked?: boolean } = {}): Promise<void> {
  if (opts.checked) return checkedView(force);
  if (!isOPFSAvailable()) return;
  // T1/U1/Z1: another vault is active now (even mid-build); this index is not its index.
  noteVaultSwitch();
  if (cache.filledVault !== null && cache.filledVault !== snapshotVault()) dropIndex();
  // U2: a build waiting for an unlock gives way if the vault it waits for is no longer the active one.
  wakeBuilds();
  // Wait for whatever runs now, whole (a build and its follow-up rounds):
  // a second caller must not query the worker between two of its steps.
  let waited = false;
  while (cache.inflight) {
    waited = true;
    await cache.inflight;
  }
  if (waited && !force && !pendingChanges()) return;
  let first: () => Promise<void>;
  const building = force || !cache.builtAt;
  if (building) first = () => build(!force);
  else if (pendingChanges() || Date.now() - cache.checkedAt >= REVALIDATE_MS) first = refresh;
  else return;
  const run = (async () => {
    const since = resets;
    await first();
    // A build that gave way (a drop or a switch while it waited or ran) is run again for the vault active now,
    // a few times at most: the caller asked for an index (Z1 no longer lets a refresh fill an unbuilt one).
    for (let tries = 0; building && !cache.builtAt && isOPFSAvailable() && since === resets && tries < 5; tries++) await build(!force);
    // Changes that arrived while that ran (a save during the first build)
    // are in the answer too — a few rounds at most, then the next call.
    // Z1: not after a build that gave way (a drop, a switch): there is no index to refresh.
    for (let round = 0; round < 3 && cache.builtAt && pendingChanges(); round++) await refresh();
  })();
  cache.inflight = run;
  try {
    await run;
  } finally {
    if (cache.inflight === run) cache.inflight = null;
  }
}

function onVaultEvent(e: VaultEvent): void {
  // Y1: a save is read again after a reused listing; a delete or a move makes the listing unusable.
  if (e.type === "write") {
    if (indexable(e.path)) watchChange(e.path);
  } else watchChange(null);
  if (e.type === "write") {
    if (indexable(e.path)) cache.dirty.add(e.path);
  } else if (e.type === "delete") {
    cache.ops.push({ type: "remove", path: e.path });
    cache.dirty.delete(e.path);
  } else if (e.type === "rename" && e.from) {
    cache.ops.push({ type: "move", from: e.from, to: e.path });
    // Saved notes in the moved folder are to be read at their new path.
    const prefix = e.from + "/";
    for (const p of [...cache.dirty]) {
      if (p !== e.from && !p.startsWith(prefix)) continue;
      cache.dirty.delete(p);
      const dest = e.path + p.slice(e.from.length);
      if (indexable(dest)) cache.dirty.add(dest);
    }
  }
}

/** Listen for changes: content changes mark files dirty, anything else re-checks the listing. */
let listenerAttached = false;
function attachInvalidator() {
  if (listenerAttached || typeof window === "undefined") return;
  listenerAttached = true;
  watchVault(onVaultEvent);
  // T4: locking forgets the index, here and in the worker (./vault/encrypted/session LOCKED_EVENT).
  window.addEventListener("lumen-vault-locked", () => dropIndex());
  window.addEventListener(WORKSPACE_CHANGED, (e) => {
    // T1/Z1: a vault switch announces a structural change; whatever the index holds is dropped at once.
    noteVaultSwitch();
    if (cache.filledVault !== null && cache.filledVault !== snapshotVault()) dropIndex();
    // U2: a build waiting for an unlock looks at the active vault again.
    wakeBuilds();
    const c = changeOf(e);
    if (c.kind === "content" && c.paths) {
      for (const p of c.paths) {
        cache.dirty.add(p);
        watchChange(p);
      }
      return;
    }
    // Y2: a structural change (a vault switch among them): a kept listing no longer describes the vault.
    watchChange(null);
    cache.pendingListing = null;
    cache.stale = true;
    cache.generation++;
    // A structural event that names its paths (an external change) also
    // says which files to re-read, whatever their mtime.
    for (const p of c.paths ?? []) if (indexable(p)) cache.dirty.add(p);
  });
}
attachInvalidator();

/** Test hook (review 17): shorter check bounds; no argument restores the defaults. */
export function __setCheckBounds(b: { checkMs?: number; viewMs?: number } = {}): void {
  checkTimeoutMs = b.checkMs ?? CHECK_TIMEOUT_MS;
  viewCheckWaitMs = b.viewMs ?? VIEW_CHECK_WAIT_MS;
}

/** Test hook (W6.36): write the snapshot now, as the idle timer would. */
export async function __saveSnapshotNow(): Promise<void> {
  await saveSnapshotNow();
}

/**
 * Test hook. `engineFactory` replaces the worker (e.g. with a fake one).
 * `keepSnapshot` keeps the stored snapshot, as a restart does (W6.36).
 */
export function __resetWorkspaceIndex(engineFactory?: () => IndexEngine, opts: { keepSnapshot?: boolean } = {}): void {
  cache.version++;
  cache.byPath = new Map();
  cache.builtAt = 0;
  cache.inflight = null;
  cache.dirty.clear();
  cache.ops = [];
  cache.stale = false;
  cache.checkedAt = 0;
  cache.listing = null;
  cache.verify = null;
  cache.filledEncrypted = false;
  cache.filledVault = null;
  cache.distrust = false;
  cache.pendingListing = null;
  watching = null;
  lastVault = null;
  epoch++;
  resets++;
  // A build waiting for an unlock gives way.
  wakeBuilds();
  void engine?.then((e) => e.dispose(), () => undefined);
  engine = null;
  engineOverride = engineFactory ?? null;
  // Tests start from an empty vault: no snapshot from an earlier one.
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  snapshotGen++;
  snapshotReset = opts.keepSnapshot ? Promise.resolve() : dropSnapshot();
}
