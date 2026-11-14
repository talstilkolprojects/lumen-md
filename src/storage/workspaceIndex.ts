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
import {
  isAssetName,
  isOPFSAvailable,
  listWorkspace,
  listWorkspaceTree,
  readWorkspaceFile,
  type WorkspaceEntry,
  type WorkspaceNode,
} from "./workspace";
import { getVaultBackend, vaultEncryptionReady, watchVault, type VaultEvent } from "./vault";
import type { BacklinkHit, IndexInput, IndexStats, SearchHit } from "./vaultIndexCore";
import type { IndexEngine } from "./vaultIndexProtocol";
import { log } from "../lib/logger";
import { scheduleIdle } from "../lib/idle";
import { dropSnapshot } from "./indexSnapshot";
import type { SnapshotKeys } from "./snapshotSeal";
import { summarize, type NoteSummary } from "./noteSummary";

export type { BacklinkHit, SearchHit } from "./vaultIndexCore";

/**
 * A note as the main thread knows it. W2.22: a compact summary
 * (./noteSummary.ts), not its text — the text lives once, in the index.
 */
export interface IndexedFile extends NoteSummary {
  /** Full workspace path. */
  path: string;
  /** Basename. */
  name: string;
  modified: number;
}

/** A note just read: its summary, and its text for the index (then dropped). */
interface ReadNote {
  file: IndexedFile;
  content: string;
}

const cache = {
  byPath: new Map<string, IndexedFile>(),
  builtAt: 0,
  inflight: null as Promise<void> | null,
  /** Files whose text changed since they were indexed (C3). */
  dirty: new Set<string>(),
  /** Deletes and moves (files or folders) not yet applied to the index, in the order they happened. */
  ops: [] as ({ type: "remove"; path: string } | { type: "move"; from: string; to: string })[],
  /** Files may have appeared / disappeared behind the events: re-list on next use. */
  stale: false,
  /** When the index was last checked against the vault listing. */
  checkedAt: 0,
  /** Bumped whenever `byPath` changes, so views can cache what they derive from it. */
  version: 0,
  /** Bumped on every structural event; a listing is reusable only within one generation. */
  generation: 0,
  /** The file tree's last listing (`workspaceTree`), which the index reuses when nothing moved since. */
  listing: null as { generation: number; tree: WorkspaceNode[] } | null,
  /** Review 12.11 S1: the index holds notes of an encrypted vault, so it is never saved in the clear. */
  filledEncrypted: false,
  /** W6.36: the check of a trusted snapshot against the vault's listing, while it runs. */
  verify: null as Promise<void> | null,
};

/** Bumped by a reset (tests): work of an earlier index must not touch the new one. */
let epoch = 0;

/** Until the check of the snapshot the index opened from is done (at once when there is none). */
async function verified(): Promise<void> {
  while (cache.verify) await cache.verify;
}

/**
 * Not every change reaches the index as an event (another tab writing
 * the same OPFS, a folder edited behind a watcher's back): at most this
 * often, a use of the index re-lists the vault and re-reads only the
 * files whose mtime changed — or that appeared.
 */
export const REVALIDATE_MS = 30_000;
/** Notes sent to the worker per message while building. */
const UPSERT_BATCH = 500;

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

function getEngine(): Promise<IndexEngine> {
  return (engine ??= createEngine());
}

/**
 * Run `fn` on the engine. If the worker died, switch to an in-thread
 * engine, give it every indexed note again, and retry once.
 */
async function withEngine<T>(fn: (e: IndexEngine) => Promise<T>): Promise<T> {
  const current = getEngine();
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
    const filled = await fillEngine(local, [...cache.byPath.values()]);
    for (const [path, f] of filled) cache.byPath.set(path, f);
    return fn(local);
  }
}

function toInput(r: ReadNote): IndexInput {
  return { path: r.file.path, name: r.file.name, content: r.content, modified: r.file.modified };
}

async function upsertAll(e: IndexEngine, notes: ReadNote[]): Promise<void> {
  for (let i = 0; i < notes.length; i += UPSERT_BATCH) await e.upsert(notes.slice(i, i + UPSERT_BATCH).map(toInput));
}

// ── Reading notes ───────────────────────────────────────────────────────

/** When the vault says `path` last changed (now, if it cannot tell). */
async function mtimeOf(path: string): Promise<number> {
  try {
    return (await getVaultBackend().stat(path))?.mtime || Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Read one file into an index entry, or null if unreadable. `modified`
 * null (a save announced by an event): ask the vault, so the next listing
 * check does not take the note for changed again.
 */
async function indexFile(e: { path: string; name: string; modified: number | null }): Promise<ReadNote | null> {
  try {
    // The mtime before the read: a write landing in between then looks
    // newer than what was read, and the next listing check reads it again.
    const modified = e.modified ?? (await mtimeOf(e.path));
    const content = await readWorkspaceFile(e.path);
    return { file: { path: e.path, name: e.name, modified, ...summarize(content) }, content };
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight (a 10k vault must not open 10k reads at once). */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

const nameOf = (path: string) => path.split("/").pop() ?? path;

/** Hidden from the tree, search and the index: dot entries at any depth (T46) and pasted assets. */
function indexable(path: string): boolean {
  return !!path && !path.split("/").some((s) => s.startsWith(".")) && !isAssetName(path);
}

function flatten(nodes: WorkspaceNode[], out: WorkspaceEntry[] = []): WorkspaceEntry[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push({ path: n.path, name: n.name, size: n.size ?? 0, modified: n.modified ?? 0 });
    else if (n.children) flatten(n.children, out);
  }
  return out;
}

/**
 * The vault's notes. After a structural event (`reuseTree`), the file
 * tree's listing of that same change, when it has one; it is used once.
 * Otherwise — the first build, the timed check for changes nobody
 * announced (another tab) — a fresh listing: a cached one would hide them.
 */
async function listNotes(reuseTree: boolean): Promise<WorkspaceEntry[]> {
  const l = cache.listing;
  cache.listing = null;
  const list =
    reuseTree && l && l.generation === cache.generation ? flatten(l.tree) : await listWorkspace({ includeAssets: false });
  return list.filter((e) => !isAssetName(e.path));
}

// ── Keeping the index in step ───────────────────────────────────────────

// ── W2.22: the index survives a restart (./indexSnapshot.ts) ─────────────

/** How the last full build got its notes: from the snapshot or by reading them. */
export const snapshotCounters = { fromSnapshot: 0, read: 0 };
const SNAPSHOT_DELAY_MS = 5_000;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotReset: Promise<void> = Promise.resolve();
let snapshotGen = 0;

function snapshotVault(): string {
  try {
    return getVaultBackend().id;
  } catch {
    return "default";
  }
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
    const state = await vaultEncryptionReady();
    if (state === "none") return cache.filledEncrypted ? null : {};
    if (state !== "unlocked") return null;
    const { restSnapshotKeys } = await import("./vault/restStore");
    const keys = restSnapshotKeys();
    return keys ? { keys } : null;
  } catch {
    return null;
  }
}

/** Whether the vault the index is about to be filled from is encrypted (or can't tell): its notes are never saved in the clear. */
async function fillingEncrypted(): Promise<boolean> {
  try {
    if (!getVaultBackend().available()) return true;
    return (await vaultEncryptionReady()) !== "none";
  } catch {
    return true;
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
      void snapshotMode()
        .then((mode) => (mode ? withEngine((eng) => eng.saveSnapshot(snapshotVault(), mode.keys)) : undefined))
        .catch(() => {});
    });
  }, SNAPSHOT_DELAY_MS);
}

/**
 * Fill an empty index with `entries`: the worker takes every note the
 * snapshot holds unchanged; the others are read here, their text sent to the
 * index and dropped. Returns the summaries.
 */
async function fillEngine(eng: IndexEngine, entries: { path: string; name: string; modified: number }[]): Promise<Map<string, IndexedFile>> {
  const out = new Map<string, IndexedFile>();
  const mode = await snapshotMode();
  const restored = mode ? await eng.restoreSnapshot(snapshotVault(), entries.map((e) => ({ path: e.path, name: e.name, modified: e.modified })), mode.keys) : [];
  for (const r of restored) out.set(r.path, r);
  snapshotCounters.fromSnapshot += restored.length;
  let batch: ReadNote[] = [];
  await mapLimit(
    entries.filter((e) => !out.has(e.path)),
    16,
    async (e) => {
      const r = await indexFile(e);
      snapshotCounters.read++;
      if (!r) return;
      out.set(e.path, r.file);
      batch.push(r);
      if (batch.length >= UPSERT_BATCH) {
        const send = batch;
        batch = [];
        await upsertAll(eng, send);
      }
    },
  );
  if (batch.length) await upsertAll(eng, batch);
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
  const mode = await snapshotMode();
  const restored = trust && mode
    ? await withEngine(async (eng) => {
        await eng.clear();
        return eng.restoreSnapshot(snapshotVault(), null, mode.keys);
      })
    : [];
  // The listing starts once the snapshot is open (W6.36): the open does not wait for it, nor share the CPU with it.
  const listing = listNotes(false);
  listing.catch(() => undefined);
  if (restored.length) {
    cache.byPath = new Map(restored.map((r) => [r.path, r] as const));
    snapshotCounters.fromSnapshot = restored.length;
    cache.builtAt = cache.checkedAt = Date.now();
    cache.version++;
    // Asked now, so the answer comes right after the worker has indexed the restored texts.
    const body = withEngine((eng) => eng.snapshotBody());
    body.catch(() => undefined);
    const v = verifySnapshot(listing, body, epoch).finally(() => {
      if (cache.verify === v) cache.verify = null;
    });
    cache.verify = v;
    return;
  }
  const list = await listing;
  const next = new Map<string, IndexedFile>();
  await withEngine(async (eng) => {
    await eng.clear();
    for (const [path, f] of await fillEngine(eng, list)) next.set(path, f);
  });
  cache.byPath = next;
  scheduleSnapshot();
  cache.builtAt = cache.checkedAt = Date.now();
  cache.version++;
}

/**
 * W6.36: the notes the index opened with from the snapshot, checked against
 * the vault's listing: a note gone is dropped, a note new or with another
 * mtime is read — every note, if the worker refused the snapshot's texts
 * (`body`) after it opened from its manifest. Never throws: when the vault can't be listed, the next use
 * of the index lists it again.
 */
async function verifySnapshot(listing: Promise<WorkspaceEntry[]>, body: Promise<{ refused: boolean }>, at: number): Promise<void> {
  try {
    const [list, texts] = await Promise.all([listing, body]);
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
  } catch (err) {
    if (at !== epoch) return;
    log.warn("vault index: checking the snapshot against the vault failed; it is checked again on next use", err);
    // Due now: the next ensureIndex lists the vault again.
    cache.checkedAt = 0;
  }
}

/** Every indexed path at or under `path` (a deleted / moved folder takes its notes with it). */
function under(path: string): string[] {
  if (cache.byPath.has(path)) return [path];
  const prefix = path + "/";
  return [...cache.byPath.keys()].filter((p) => p.startsWith(prefix));
}

type IndexOp = { kind: "remove"; path: string } | { kind: "move"; from: string; to: string; name: string };
type ToRead = { path: string; name: string; modified: number | null };

/** A fresh listing against the index: notes gone are dropped (in `cache.byPath` and as `indexOps`), notes new or with another mtime go to `toRead`. */
function diffListing(list: WorkspaceEntry[], indexOps: IndexOp[], toRead: Map<string, ToRead>): void {
  const seen = new Set(list.map((e) => e.path));
  for (const path of [...cache.byPath.keys()]) {
    if (!seen.has(path)) {
      cache.byPath.delete(path);
      indexOps.push({ kind: "remove", path });
    }
  }
  for (const e of list) if (cache.byPath.get(e.path)?.modified !== e.modified) toRead.set(e.path, e);
}

/**
 * C3 / 8.4: apply what changed since the last use — moves and deletes
 * without reading, then re-read only the dirty files (plus, after a
 * structural change, the ones whose mtime differs from the listing).
 */
async function refresh(): Promise<void> {
  // After the snapshot's check (W6.36): changes apply in the order they happened.
  await verified();
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
  await applyChanges(indexOps, toRead, epoch);
}

/** Read `toRead`, then send the removes, moves and new texts to the index, in order. Nothing when the index was reset meanwhile. */
async function applyChanges(indexOps: IndexOp[], toRead: Map<string, ToRead>, at: number): Promise<void> {
  const toWrite: ReadNote[] = [];
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
    if (latest.size) await upsertAll(eng, [...latest.values()]);
  });
}

function pendingChanges(): boolean {
  return cache.stale || cache.dirty.size > 0 || cache.ops.length > 0;
}

export async function ensureIndex(force = false): Promise<void> {
  if (!isOPFSAvailable()) return;
  // Wait for whatever runs now, whole (a build and its follow-up rounds):
  // a second caller must not query the worker between two of its steps.
  let waited = false;
  while (cache.inflight) {
    waited = true;
    await cache.inflight;
  }
  if (waited && !force && !pendingChanges()) return;
  let first: () => Promise<void>;
  if (force || !cache.builtAt) first = () => build(!force);
  else if (pendingChanges() || Date.now() - cache.checkedAt >= REVALIDATE_MS) first = refresh;
  else return;
  const run = (async () => {
    await first();
    // Changes that arrived while that ran (a save during the first build)
    // are in the answer too — a few rounds at most, then the next call.
    for (let round = 0; round < 3 && pendingChanges(); round++) await refresh();
  })();
  cache.inflight = run;
  try {
    await run;
  } finally {
    if (cache.inflight === run) cache.inflight = null;
  }
}

function onVaultEvent(e: VaultEvent): void {
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
  window.addEventListener(WORKSPACE_CHANGED, (e) => {
    const c = changeOf(e);
    if (c.kind === "content" && c.paths) {
      for (const p of c.paths) cache.dirty.add(p);
      return;
    }
    cache.stale = true;
    cache.generation++;
    // A structural event that names its paths (an external change) also
    // says which files to re-read, whatever their mtime.
    for (const p of c.paths ?? []) if (indexable(p)) cache.dirty.add(p);
  });
}
attachInvalidator();

// ── Queries ─────────────────────────────────────────────────────────────

/** Every indexed note (after ensureIndex) — for the tags panel and other views. */
export function indexedFiles(): IndexedFile[] {
  return [...cache.byPath.values()];
}

/**
 * The file tree (directories first, then files, by name) — the same
 * listing the index re-validates against, so after a structural change the
 * vault is listed once for both.
 */
export async function workspaceTree(): Promise<WorkspaceNode[]> {
  const generation = cache.generation;
  const tree = await listWorkspaceTree();
  if (generation === cache.generation) cache.listing = { generation, tree };
  return tree;
}

/** Find files whose wiki-links point at the given target (path or basename). */
export async function findBacklinks(targetPath: string): Promise<BacklinkHit[]> {
  await ensureIndex();
  await verified();
  if (!cache.byPath.size) return [];
  return withEngine((e) => e.backlinks(targetPath));
}

/** Cheap fuzzy + substring search across filenames, paths, and content. */
export async function searchWorkspace(
  query: string,
  /** `filter`: only these paths — applied before `limit`. */
  opts: { limit?: number; filter?: (path: string) => boolean } = {},
): Promise<SearchHit[]> {
  await ensureIndex();
  await verified();
  if (!cache.byPath.size) return [];
  const filter = opts.filter;
  // A function cannot cross into the worker: send the paths it allows.
  const paths = filter ? [...cache.byPath.keys()].filter((p) => filter(p)) : undefined;
  return withEngine((e) => e.search(query, { limit: opts.limit ?? 30, paths }));
}

/**
 * W2.22 — the text of indexed notes, read from the index (the main thread
 * keeps summaries only). For a view that reads the text once and lets it go:
 * each note's summary with its `content`. All notes when `paths` is omitted.
 */
export async function indexedNotes(paths?: readonly string[]): Promise<Array<IndexedFile & { content: string }>> {
  await verified();
  if (!cache.byPath.size) return [];
  const want = paths ? paths.filter((p) => cache.byPath.has(p)) : undefined;
  if (want && !want.length) return [];
  const texts = await withEngine((e) => e.texts(want ? [...want] : undefined));
  const out: Array<IndexedFile & { content: string }> = [];
  for (const t of texts) {
    const f = cache.byPath.get(t.path);
    if (f) out.push({ ...f, content: t.content });
  }
  return out;
}

/** One note's text from the index, or null when it is not indexed. */
export async function indexedNoteText(path: string): Promise<string | null> {
  return (await indexedNotes([path]))[0]?.content ?? null;
}

/** Notes related to a paragraph (plan W2.2), ranked by the index's BM25 in the index worker. */
export async function relatedInIndex(query: import("./vaultIndexProtocol").RelatedQuery): Promise<import("../related/related").RelatedHit[]> {
  await ensureIndex();
  await verified();
  return withEngine((e) => e.related(query));
}

/**
 * Run a ```tasks``` query over every note in the vault (plan 4.13), in the
 * index worker. Dates in the query are relative to the user's local today.
 */
export async function queryVaultTasks(query: string, today = new Date()): Promise<import("../tasks/taskQuery").QueryResult> {
  await ensureIndex();
  await verified();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return withEngine((e) => e.tasks(query, iso));
}

/**
 * W6.36: resolves once the snapshot the index opened from has been checked
 * against the vault (at once when it opened otherwise). Queries wait for it
 * themselves; a view showing `indexedFiles()` can wait for it to re-derive.
 */
export function indexChecked(): Promise<void> {
  return verified();
}

/** Changes whenever the indexed files do: a cache of something derived from them is good while it is the same. */
export function indexVersion(): number {
  return cache.version;
}

/** Work counters of the index (files, notes indexed so far…) — for tests and the perf spec. */
export async function indexStats(): Promise<IndexStats & { engine: IndexEngine["kind"] }> {
  const stats = await withEngine((e) => e.stats());
  return { ...stats, engine: (await getEngine()).kind };
}

/** Test hook (W6.36): write the snapshot now, as the idle timer would. */
export async function __saveSnapshotNow(): Promise<void> {
  const mode = await snapshotMode();
  if (mode) await withEngine((eng) => eng.saveSnapshot(snapshotVault(), mode.keys));
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
  epoch++;
  void engine?.then((e) => e.dispose(), () => undefined);
  engine = null;
  engineOverride = engineFactory ?? null;
  // Tests start from an empty vault: no snapshot from an earlier one.
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  snapshotGen++;
  snapshotReset = opts.keepSnapshot ? Promise.resolve() : dropSnapshot();
}
