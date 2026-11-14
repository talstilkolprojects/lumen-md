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
import { getVaultBackend, watchVault, type VaultEvent } from "./vault";
import type { BacklinkHit, IndexInput, IndexStats, SearchHit } from "./vaultIndexCore";
import { wikiTargetsOf } from "./wikiTargets";
import type { IndexEngine } from "./vaultIndexProtocol";
import { log } from "../lib/logger";

export type { BacklinkHit, SearchHit } from "./vaultIndexCore";

export interface IndexedFile {
  /** Full workspace path. */
  path: string;
  /** Basename. */
  name: string;
  content: string;
  modified: number;
  /** Wiki-link targets referenced by this file (raw `[[target]]` text). */
  wikiTargets: string[];
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
};

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
  const e = await getEngine();
  try {
    return await fn(e);
  } catch (err) {
    if (e.kind !== "worker") throw err;
    log.warn("vault index worker failed; indexing on the main thread", err);
    e.dispose();
    const local = await localIndexEngine();
    engine = Promise.resolve(local);
    await upsertAll(local, [...cache.byPath.values()]);
    return fn(local);
  }
}

function toInput(f: IndexedFile): IndexInput {
  return { path: f.path, name: f.name, content: f.content, modified: f.modified };
}

async function upsertAll(e: IndexEngine, files: IndexedFile[]): Promise<void> {
  for (let i = 0; i < files.length; i += UPSERT_BATCH) await e.upsert(files.slice(i, i + UPSERT_BATCH).map(toInput));
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
async function indexFile(e: { path: string; name: string; modified: number | null }): Promise<IndexedFile | null> {
  try {
    // The mtime before the read: a write landing in between then looks
    // newer than what was read, and the next listing check reads it again.
    const modified = e.modified ?? (await mtimeOf(e.path));
    const content = await readWorkspaceFile(e.path);
    return { path: e.path, name: e.name, content, modified, wikiTargets: wikiTargetsOf(content) };
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

/** Build the whole index (first use, or `ensureIndex(true)`). */
async function build(): Promise<void> {
  if (!isOPFSAvailable()) return;
  // Clear before reading: a change announced while the build runs (it may
  // have read that file already) must survive for the next ensureIndex.
  cache.dirty.clear();
  cache.ops = [];
  cache.stale = false;
  const list = await listNotes(false);
  const next = new Map<string, IndexedFile>();
  await mapLimit(list, 16, async (e) => {
    const f = await indexFile(e);
    if (f) next.set(e.path, f);
  });
  cache.byPath = next;
  await withEngine(async (eng) => {
    await eng.clear();
    await upsertAll(eng, [...next.values()]);
  });
  cache.builtAt = cache.checkedAt = Date.now();
  cache.version++;
}

/** Every indexed path at or under `path` (a deleted / moved folder takes its notes with it). */
function under(path: string): string[] {
  if (cache.byPath.has(path)) return [path];
  const prefix = path + "/";
  return [...cache.byPath.keys()].filter((p) => p.startsWith(prefix));
}

/**
 * C3 / 8.4: apply what changed since the last use — moves and deletes
 * without reading, then re-read only the dirty files (plus, after a
 * structural change, the ones whose mtime differs from the listing).
 */
async function refresh(): Promise<void> {
  const gone: string[] = [];
  const toWrite: IndexedFile[] = [];
  // In order: deleting A/x.md and then moving A to B must not bring x back as B/x.md.
  for (const op of cache.ops.splice(0)) {
    if (op.type === "remove") {
      for (const p of under(op.path)) {
        cache.byPath.delete(p);
        gone.push(p);
      }
      continue;
    }
    const { from, to } = op;
    for (const p of under(from)) {
      const f = cache.byPath.get(p)!;
      cache.byPath.delete(p);
      gone.push(p);
      const dest = to + p.slice(from.length);
      if (!indexable(dest)) continue;
      const moved = { ...f, path: dest, name: nameOf(dest) };
      cache.byPath.set(dest, moved);
      toWrite.push(moved);
    }
    // Moved out of a hidden folder (e.g. restored from the trash): read it.
    if (indexable(to) && !under(to).length) cache.stale = true;
  }

  const toRead = new Map<string, { path: string; name: string; modified: number | null }>();
  if (cache.stale || Date.now() - cache.checkedAt >= REVALIDATE_MS) {
    const structural = cache.stale;
    cache.stale = false;
    cache.checkedAt = Date.now();
    const list = await listNotes(structural);
    const seen = new Set(list.map((e) => e.path));
    for (const path of [...cache.byPath.keys()]) {
      if (!seen.has(path)) {
        cache.byPath.delete(path);
        gone.push(path);
      }
    }
    for (const e of list) if (cache.byPath.get(e.path)?.modified !== e.modified) toRead.set(e.path, e);
  }
  const dirty = [...cache.dirty];
  cache.dirty.clear();
  for (const path of dirty) {
    if (!indexable(path) || toRead.has(path)) continue;
    toRead.set(path, { path, name: cache.byPath.get(path)?.name ?? nameOf(path), modified: null });
  }
  await mapLimit([...toRead.values()], 16, async (e) => {
    const f = await indexFile(e);
    if (f) {
      cache.byPath.set(e.path, f);
      toWrite.push(f);
    } else if (cache.byPath.delete(e.path)) gone.push(e.path);
  });
  // Views that cache what they derive from the index (wiki-link completion) re-derive.
  if (gone.length || toWrite.length) cache.version++;
  const written = new Set(toWrite.map((f) => f.path));
  const removedNow = gone.filter((p) => !written.has(p) && !cache.byPath.has(p));
  if (!removedNow.length && !toWrite.length) return;
  await withEngine(async (eng) => {
    if (removedNow.length) await eng.remove(removedNow);
    // Only what the index holds now: a path moved again (A → B → C) or
    // deleted after a move is not sent; last write wins for a re-read.
    const latest = new Map(toWrite.filter((f) => cache.byPath.get(f.path) === f).map((f) => [f.path, f]));
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
  if (force || !cache.builtAt) first = build;
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
  if (!cache.byPath.size) return [];
  const filter = opts.filter;
  // A function cannot cross into the worker: send the paths it allows.
  const paths = filter ? [...cache.byPath.keys()].filter((p) => filter(p)) : undefined;
  return withEngine((e) => e.search(query, { limit: opts.limit ?? 30, paths }));
}

/**
 * Run a ```tasks``` query over every note in the vault (plan 4.13), in the
 * index worker. Dates in the query are relative to the user's local today.
 */
export async function queryVaultTasks(query: string, today = new Date()): Promise<import("../tasks/taskQuery").QueryResult> {
  await ensureIndex();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return withEngine((e) => e.tasks(query, iso));
}

/** Work counters of the index (files, notes indexed so far…) — for tests and the perf spec. */
export async function indexStats(): Promise<IndexStats & { engine: IndexEngine["kind"] }> {
  const stats = await withEngine((e) => e.stats());
  return { ...stats, engine: (await getEngine()).kind };
}

/** Changes whenever the indexed files do: a cache of something derived from them is good while it is the same. */
export function indexVersion(): number {
  return cache.version;
}

/** Test hook. `engineFactory` replaces the worker (e.g. with a fake one). */
export function __resetWorkspaceIndex(engineFactory?: () => IndexEngine): void {
  cache.version++;
  cache.byPath = new Map();
  cache.builtAt = 0;
  cache.inflight = null;
  cache.dirty.clear();
  cache.ops = [];
  cache.stale = false;
  cache.checkedAt = 0;
  cache.listing = null;
  void engine?.then((e) => e.dispose(), () => undefined);
  engine = null;
  engineOverride = engineFactory ?? null;
}
