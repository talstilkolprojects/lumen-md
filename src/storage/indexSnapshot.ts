/**
 * W2.22 — the vault index survives a restart. After the index changes, the
 * notes it holds (path, mtime, text) are written to IndexedDB while the
 * browser is idle. The next open lists the vault and takes every note whose
 * mtime still matches from the snapshot, reading only the rest: a 100,000-
 * note vault opens without 100,000 file reads.
 *
 * The snapshot is a cache, never the truth: a note's text is used only if
 * the vault still lists it with the same mtime, and a missing, old-format or
 * unreadable snapshot just means a full build, as before.
 */
import { createStore, get, set, del } from "idb-keyval";

export const SNAPSHOT_VERSION = 1;

export interface SnapshotFile {
  path: string;
  name: string;
  modified: number;
  content: string;
}

interface Stored {
  v: number;
  /** Which vault (workspace name), so two vaults never share one snapshot. */
  vault: string;
  /** Columns rather than objects: a third less to clone at 100,000 notes. */
  paths: string[];
  names: string[];
  modified: number[];
  contents: string[];
}

let store: ReturnType<typeof createStore> | null = null;
const db = () => (store ??= createStore("lumen-vault-index", "snapshot"));
const KEY = "notes";

export function encodeSnapshot(vault: string, files: Iterable<SnapshotFile>): Stored {
  const s: Stored = { v: SNAPSHOT_VERSION, vault, paths: [], names: [], modified: [], contents: [] };
  for (const f of files) {
    s.paths.push(f.path);
    s.names.push(f.name);
    s.modified.push(f.modified);
    s.contents.push(f.content);
  }
  return s;
}

/** The snapshot as a path → file map, or null if it is missing, for another vault or malformed. */
export function decodeSnapshot(raw: unknown, vault: string): Map<string, SnapshotFile> | null {
  const s = raw as Stored | undefined;
  if (!s || s.v !== SNAPSHOT_VERSION || s.vault !== vault) return null;
  const n = s.paths?.length;
  if (!Array.isArray(s.paths) || ![s.names, s.modified, s.contents].every((c) => Array.isArray(c) && c.length === n)) return null;
  const out = new Map<string, SnapshotFile>();
  for (let i = 0; i < n; i++) {
    const path = s.paths[i];
    const content = s.contents[i];
    if (typeof path !== "string" || typeof content !== "string" || typeof s.modified[i] !== "number") return null;
    out.set(path, { path, name: String(s.names[i]), modified: s.modified[i], content });
  }
  return out;
}

export async function loadSnapshot(vault: string): Promise<Map<string, SnapshotFile> | null> {
  try {
    return decodeSnapshot(await get(KEY, db()), vault);
  } catch {
    return null;
  }
}

export async function saveSnapshot(vault: string, files: Iterable<SnapshotFile>): Promise<void> {
  try {
    await set(KEY, encodeSnapshot(vault, files), db());
  } catch {
    // Quota or private mode: the next open builds in full, as before.
    await del(KEY, db()).catch(() => {});
  }
}

export async function dropSnapshot(): Promise<void> {
  await del(KEY, db()).catch(() => {});
}
