/**
 * Noticing changes made outside Lumen (plan 4.4): another editor, Obsidian,
 * a sync client or git working on the vault folder.
 *
 * A watcher compares snapshots of the vault (every file's size and mtime)
 * and reports what changed through the backend's `notifyExternal` hook, so
 * every `watch` / `watchVault` listener — the file tree, the index, the open
 * tabs — sees it like any other vault event:
 *
 * - a changed or new file → "write"; a vanished file → "delete";
 * - a vanished and a new file with the same size and mtime → "rename"
 *   (what a move or rename on disk looks like).
 *
 * Lumen's own writes are not reported: after each own write the watcher
 * re-reads that file's stat as the new baseline, and own deletes and renames
 * are absorbed at the next comparison.
 *
 * When to compare: on desktop the Rust side returns the whole snapshot in
 * one call (`vault_snapshot`), polled about once a second. In the browser a
 * `FileSystemObserver` (Chromium) triggers a comparison as soon as the
 * folder changes, with slower polling as the backstop; without it, the
 * folder is polled about once a second.
 */

import { log } from "../../lib/logger";
import type { VaultBackend, VaultEvent } from "./types";

export interface SnapEntry {
  size: number;
  mtime: number;
}
export type Snapshot = Map<string, SnapEntry>;

/** A folder that is not there (any more), or is a file now: what "vanished while walking" looks like. */
function isNotFound(e: unknown): boolean {
  const err = e as { name?: unknown; code?: unknown } | null;
  return err?.name === "NotFoundError" || err?.name === "TypeMismatchError" || err?.code === "ENOENT";
}

/** How listSnapshot treats a sub-folder that fails to list (review t5, L1). */
export interface SnapshotOptions {
  /** The previous snapshot: a skipped sub-folder keeps its entries from here, so nothing in it reads as deleted. */
  prev?: Snapshot | null;
  /**
   * Consecutive failures per sub-folder, kept by the caller across snapshots.
   * With it, a sub-folder's failure rejects the snapshot (a passing error: the
   * watcher keeps its baseline) until it has failed `skipAfter` times in a
   * row; from then on it is skipped. Without it, a failing sub-folder is
   * skipped at once.
   */
  failures?: Map<string, number>;
  /** Failures in a row before a sub-folder is skipped (default 3). */
  skipAfter?: number;
  /** Called for each sub-folder skipped in this snapshot. */
  onSkip?: (dir: string, err: unknown) => void;
}

/** The skip threshold the watcher uses: a few polls, so a passing error never skips a folder. */
export const SKIP_AFTER = 3;

/**
 * Every file of `backend` with size and mtime (by listing; dot folders
 * included). A sub-folder that vanished while walking is skipped. The vault
 * root failing to list rejects, so the watcher keeps its previous baseline
 * instead of reporting the whole vault as deleted (2.83, Codex P2 on #258).
 * Any other failure of a sub-folder — a revoked permission, an I/O error —
 * rejects while it may be passing; a sub-folder that keeps failing (EACCES,
 * a cloud-drive placeholder) is skipped, keeping its entries from `prev`, so
 * one unreadable folder no longer stops every check (review t5, L1).
 */
export async function listSnapshot(backend: VaultBackend, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const out: Snapshot = new Map();
  const skipAfter = opts.skipAfter ?? SKIP_AFTER;
  const seen = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await backend.list(dir);
    } catch (err) {
      if (dir === "") throw err;
      if (isNotFound(err)) return; // vanished while walking
      const n = (opts.failures?.get(dir) ?? 0) + 1;
      seen.add(dir);
      opts.failures?.set(dir, n);
      if (opts.failures && n < skipAfter) throw err;
      // Skipped: what the last snapshot knew under it stays as it was.
      for (const [path, e] of opts.prev ?? []) if (path.startsWith(dir + "/")) out.set(path, e);
      opts.onSkip?.(dir, err);
      return;
    }
    seen.add(dir);
    opts.failures?.delete(dir);
    for (const e of entries) {
      if (e.kind === "directory") await walk(e.path);
      else out.set(e.path, { size: e.size ?? 0, mtime: e.mtime ?? 0 });
    }
  };
  await walk("");
  // A folder that is gone (or not walked: under a skipped one) forgets its count.
  for (const dir of [...(opts.failures?.keys() ?? [])]) if (!seen.has(dir)) opts.failures!.delete(dir);
  return out;
}

/** What changed from `prev` to `next`, as vault events (renames paired 1:1 by size + mtime). */
export function diffSnapshots(prev: Snapshot, next: Snapshot): Omit<VaultEvent, "origin">[] {
  const events: Omit<VaultEvent, "origin">[] = [];
  const gone: string[] = [];
  const added: string[] = [];
  for (const [path, a] of prev) {
    const b = next.get(path);
    if (!b) gone.push(path);
    else if (a.size !== b.size || a.mtime !== b.mtime) events.push({ type: "write", path });
  }
  for (const path of next.keys()) if (!prev.has(path)) added.push(path);
  const key = (e: SnapEntry) => `${e.size}:${e.mtime}`;
  const addedByKey = new Map<string, string[]>();
  for (const p of added) {
    const k = key(next.get(p)!);
    addedByKey.set(k, [...(addedByKey.get(k) ?? []), p]);
  }
  const goneByKey = new Map<string, number>();
  for (const p of gone) {
    const k = key(prev.get(p)!);
    goneByKey.set(k, (goneByKey.get(k) ?? 0) + 1);
  }
  const pairedAdded = new Set<string>();
  for (const from of gone) {
    const k = key(prev.get(from)!);
    const candidates = addedByKey.get(k);
    // Only an unambiguous pair — one vanished and one new file with that
    // size and mtime — is a rename.
    if (candidates && candidates.length === 1 && goneByKey.get(k) === 1 && prev.get(from)!.mtime > 0) {
      pairedAdded.add(candidates[0]);
      events.push({ type: "rename", from, path: candidates[0] });
    } else {
      events.push({ type: "delete", path: from });
    }
  }
  for (const p of added) if (!pairedAdded.has(p)) events.push({ type: "write", path: p });
  return events;
}

export interface WatchOptions {
  /** How to take a snapshot (default: list the backend). */
  snapshot?: () => Promise<Snapshot>;
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
  /**
   * Something that calls `poke()` as soon as the storage changes (e.g. a
   * FileSystemObserver); returns its stop function.
   */
  observe?: (poke: () => void) => (() => void) | null;
  /**
   * Called once per sub-folder (per watcher) when it is skipped because it
   * keeps failing to list: the place to tell the user that changes in it are
   * not noticed (review t5, L1).
   */
  onUnreadable?: (dir: string) => void;
}

/**
 * Watch `backend` for changes made outside Lumen and report them through
 * `backend.notifyExternal`. Returns the stop function.
 */
export function watchExternalChanges(backend: VaultBackend, opts: WatchOptions = {}): () => void {
  let baseline: Snapshot | null = null;
  const failures = new Map<string, number>();
  const warned = new Set<string>();
  const take =
    opts.snapshot ??
    (() =>
      listSnapshot(backend, {
        prev: baseline,
        failures,
        onSkip: (dir, err) => {
          if (warned.has(dir)) return;
          warned.add(dir);
          log.warn("vault change check skips a folder it cannot list", err);
          opts.onUnreadable?.(dir);
        },
      }));
  let running = false;
  let again = false;
  let stopped = false;
  /** Own deletes / renames / mkdirs since the last comparison (path prefixes). */
  const ownPrefixes = new Set<string>();
  /**
   * Own writes whose resulting stat is still being read: a comparison
   * leaves these paths for the next round instead of guessing. Once the stat
   * is known it is the baseline, so only a later, different stat (another
   * program writing the same path) is reported.
   */
  const pendingOwn = new Map<string, number>();

  const offOwn = backend.watch((e) => {
    if (e.origin !== "self" || !baseline) return;
    if (e.type === "write") {
      // The new baseline for this file is what Lumen just wrote.
      const path = e.path;
      pendingOwn.set(path, (pendingOwn.get(path) ?? 0) + 1);
      void backend
        .stat(path)
        .then((st) => {
          if (st && st.kind === "file" && baseline) baseline.set(path, { size: st.size, mtime: st.mtime });
        })
        .catch(() => undefined)
        .finally(() => {
          const n = (pendingOwn.get(path) ?? 1) - 1;
          if (n > 0) pendingOwn.set(path, n);
          else pendingOwn.delete(path);
        });
    } else {
      ownPrefixes.add(e.path);
      if (e.from) ownPrefixes.add(e.from);
    }
  });

  const compare = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const next = await take();
      if (stopped) return;
      if (baseline) {
        const prev = baseline;
        const own = new Set(ownPrefixes);
        ownPrefixes.clear();
        const ownMatch = (p: string) => [...own].some((o) => p === o || p.startsWith(o + "/"));
        // Paths with an own write in flight are compared next round.
        for (const p of pendingOwn.keys()) {
          const old = prev.get(p);
          if (old) next.set(p, old);
          else next.delete(p);
        }
        for (const ev of diffSnapshots(prev, next)) {
          if (ownMatch(ev.path) || (ev.from && ownMatch(ev.from))) continue;
          backend.notifyExternal(ev);
        }
      }
      baseline = next;
    } catch (err) {
      // No events, and the baseline stays what it was: the next comparison
      // that can list the vault reports what really changed.
      log.warn("vault change check failed", err);
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void compare();
      }
    }
  };

  void compare(); // the first snapshot is the baseline
  const stopObserve = opts.observe?.(() => void compare()) ?? null;
  const timer = setInterval(() => void compare(), opts.intervalMs ?? 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
    stopObserve?.();
    offOwn();
  };
}

/**
 * A `FileSystemObserver` on `handle` (Chromium), calling `poke` on every
 * change record; null where the browser has none.
 */
export function observeDirectoryHandle(handle: FileSystemDirectoryHandle, poke: () => void): (() => void) | null {
  const Ctor = (globalThis as unknown as { FileSystemObserver?: new (cb: () => void) => { observe(h: FileSystemHandle, o: { recursive: boolean }): Promise<void>; disconnect(): void } }).FileSystemObserver;
  if (typeof Ctor !== "function") return null;
  try {
    const observer = new Ctor(() => poke());
    void observer.observe(handle, { recursive: true }).catch((err: unknown) => log.warn("FileSystemObserver failed", err));
    return () => observer.disconnect();
  } catch (err) {
    log.warn("FileSystemObserver unavailable", err);
    return null;
  }
}
