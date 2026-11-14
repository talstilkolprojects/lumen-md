/**
 * Per-file and per-folder sync state (plan W1.8): what the file tree's
 * badges and the activity panel show. Pure: computed from what the engine
 * already knows after a round (the local listing, the base, the manifest it
 * read, the paths it held and why) and the device's exclusion rules.
 *
 *   synced    — this device and the vault agree on the version;
 *   pending   — a change waits to go up or come down (next round);
 *   conflict  — both sides changed and the user has not decided yet;
 *   error     — the path can't be synced as it is (a file and a folder with
 *               the same name on the two sides, a name this device refuses);
 *   excluded  — this device's rules keep it out of the sync (it stays here).
 */

import { isSyncedPath } from "./localFiles";
import type { ManifestEntry } from "./manifest";

export type FileSyncState = "synced" | "pending" | "conflict" | "error" | "excluded";

/** Why the engine held a path in a round: a conflict the user has not settled, a write that has to be retried, or a tree clash. */
export type HoldReason = "conflict" | "retry" | "clash";

export interface FileStatus {
  state: FileSyncState;
  /** For `pending`: which way the change goes. */
  direction?: "up" | "down";
  /** For `excluded`: the rule; for `error` / `conflict`: the hold reason. */
  reason?: string;
}

/** Decide whether a path is kept out of the sync on this device; the reason, or null. `size` is null when unknown or deleted. */
export type ExcludeRule = (path: string, size: number | null) => string | null;

export function sameEntry(a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.ver === b.ver && a.rev === b.rev && !!a.deleted === !!b.deleted;
}

export function liveHash(e: ManifestEntry | undefined): string | null {
  return e && !e.deleted ? e.hash : null;
}

export interface StatusInput {
  local: ReadonlyMap<string, { hash: string; size?: number }>;
  base: Readonly<Record<string, ManifestEntry>>;
  /** The manifest's files as last read, or null before the first round. */
  remote: Readonly<Record<string, ManifestEntry>> | null;
  holds: ReadonlyMap<string, HoldReason>;
  exclude: ExcludeRule;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The state of every file this device or the vault has. */
export function computeFileStates(i: StatusInput): Map<string, FileStatus> {
  const out = new Map<string, FileStatus>();
  const paths = new Set<string>([...i.local.keys(), ...Object.keys(i.base), ...(i.remote ? Object.keys(i.remote) : [])]);
  for (const path of [...paths].sort()) {
    if (!isSyncedPath(path)) continue;
    const l = i.local.get(path);
    const b = own(i.base, path) ? i.base[path] : undefined;
    const r = i.remote && own(i.remote, path) ? i.remote[path] : undefined;
    const remoteLive = !!r && !r.deleted;
    if (!l && !liveHash(b) && !remoteLive) continue; // nothing anywhere
    const remoteChanged = i.remote !== null && !sameEntry(r, b);
    const excluded = (l ? i.exclude(path, l.size ?? null) : null) ?? (remoteChanged && remoteLive ? i.exclude(path, r!.size) : null) ?? (!l && remoteLive ? i.exclude(path, r!.size) : null);
    if (excluded) {
      out.set(path, { state: "excluded", reason: excluded });
      continue;
    }
    const hold = i.holds.get(path);
    if (hold === "conflict") out.set(path, { state: "conflict", reason: hold });
    else if (hold === "clash") out.set(path, { state: "error", reason: hold });
    else if ((l?.hash ?? null) !== liveHash(b)) out.set(path, { state: "pending", direction: "up" });
    else if (remoteChanged) out.set(path, { state: "pending", direction: "down" });
    else if (hold === "retry") out.set(path, { state: "pending" });
    else out.set(path, { state: "synced" });
  }
  return out;
}

const SEVERITY: Record<FileSyncState, number> = { excluded: 0, synced: 1, pending: 2, conflict: 3, error: 4 };

/**
 * Each folder takes the most urgent state inside it (error, then conflict,
 * then pending, then synced); a folder whose files are all excluded is
 * excluded. Keys are folder paths without a trailing slash.
 */
export function folderStates(files: ReadonlyMap<string, FileStatus>): Map<string, FileSyncState> {
  const out = new Map<string, FileSyncState>();
  for (const [path, st] of files) {
    const segs = path.split("/");
    for (let k = 1; k < segs.length; k++) {
      const dir = segs.slice(0, k).join("/");
      const cur = out.get(dir);
      if (cur === undefined || SEVERITY[st.state] > SEVERITY[cur]) out.set(dir, st.state);
    }
  }
  return out;
}

/** Counts per state, for the panel's summary line. */
export function countStates(files: ReadonlyMap<string, FileStatus>): Record<FileSyncState, number> {
  const n: Record<FileSyncState, number> = { synced: 0, pending: 0, conflict: 0, error: 0, excluded: 0 };
  for (const st of files.values()) n[st.state]++;
  return n;
}
