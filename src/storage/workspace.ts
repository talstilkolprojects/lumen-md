/**
 * The workspace: the user's notes and attachments, addressed by
 * forward-slash paths relative to the vault root, e.g. `notes/2026/april.md`.
 *
 * Storage itself is the active vault backend (./vault — OPFS by default;
 * plan 4.1). The functions here are thin wrappers over it that keep the
 * workspace's own policy: dot entries (`.trash/`, `.obsidian/`) and pasted
 * assets stay out of listings unless asked for, existence checks never
 * throw. Nothing outside ./vault touches the browser's file-system handles.
 */

import { randomId } from "../lib/cryptoRandom";
import { getVaultBackend, VaultNotFoundError, type VaultData, type VaultEntry } from "./vault";
import { basename, dirname, splitPath } from "./vault/shared";

export { basename, dirname, joinPath, splitPath } from "./vault/shared";
export { WorkspaceConflictError } from "./vault/types";
export type { VaultEntry } from "./vault/types";
import { readText } from "./textCodec";

export interface WorkspaceEntry {
  /** File path relative to the workspace root. */
  path: string;
  /** File basename (no directory). */
  name: string;
  size: number;
  /** mtime (ms) since epoch. */
  modified: number;
}

export interface WorkspaceNode {
  /** Path relative to the workspace root, no leading slash. Empty for root. */
  path: string;
  /** Basename of this node. */
  name: string;
  kind: "file" | "directory";
  size?: number;
  modified?: number;
  /** Children for directories, sorted: directories first then files, alpha. */
  children?: WorkspaceNode[];
}

const vault = () => getVaultBackend();

// ── Recursive tree ───────────────────────────────────────────────────────

async function readDirInto(
  dir: string,
  opts: { includeAssets: boolean; includeHidden: boolean },
): Promise<WorkspaceNode[]> {
  const out: WorkspaceNode[] = [];
  for (const entry of await vault().list(dir)) {
    const { name, path } = entry;
    // Dot entries are app data (".trash", ".obsidian"), not notes (T46):
    // hidden from the tree, search and the index. Sync callers still need
    // real repository content such as `.github/` — only the trash stays out.
    if (name.startsWith(".") && (!opts.includeHidden || (!dir && name === ".trash"))) continue;
    if (entry.kind === "directory") {
      let children: WorkspaceNode[];
      try {
        children = await readDirInto(path, opts);
      } catch (e) {
        // Deleted while we were listing: leave it out.
        if (e instanceof VaultNotFoundError) continue;
        throw e;
      }
      out.push({ path, name, kind: "directory", children });
    } else {
      if (!opts.includeAssets && isAssetName(name)) continue;
      out.push(
        entry.size === undefined
          ? { path, name, kind: "file" }
          : { path, name, kind: "file", size: entry.size, modified: entry.mtime ?? 0 },
      );
    }
  }
  // The backend lists directories first, then files, by name.
  return out;
}

/** Recursive tree of all entries in the workspace. */
export async function listWorkspaceTree(
  opts: { includeAssets?: boolean; includeHidden?: boolean } = {},
): Promise<WorkspaceNode[]> {
  return readDirInto("", { includeAssets: !!opts.includeAssets, includeHidden: !!opts.includeHidden });
}

/**
 * Backwards-compatible flat listing — recurses through every directory and
 * returns a flat array of files only. `includeHidden` keeps dot entries
 * (except the root `.trash/`) for callers that mirror the vault (git, cloud sync).
 */
export async function listWorkspace(
  opts: { includeAssets?: boolean; includeHidden?: boolean } = {},
): Promise<WorkspaceEntry[]> {
  const tree = await listWorkspaceTree(opts);
  const out: WorkspaceEntry[] = [];
  function visit(nodes: WorkspaceNode[]) {
    for (const n of nodes) {
      if (n.kind === "file") {
        out.push({
          path: n.path,
          name: n.name,
          size: n.size ?? 0,
          modified: n.modified ?? 0,
        });
      } else if (n.children) {
        visit(n.children);
      }
    }
  }
  visit(tree);
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

// ── File operations (path-aware) ─────────────────────────────────────────

/**
 * The direct children of folder `dir` ("" = the root), dot entries
 * included, directories first. Rejects when `dir` is not a folder.
 */
export async function listWorkspaceDir(dir: string): Promise<VaultEntry[]> {
  return vault().list(dir);
}

export async function readWorkspaceFile(path: string): Promise<string> {
  // Keeps a BOM: a plain text read drops it, and the next save would too (W4.30).
  return readText(await vault().read(path));
}

/**
 * Per-path serialization for workspace writes. Every write through this
 * module holds the path's lock — a Web Lock, so other tabs of the app (and
 * the sync / agent code running in them) queue behind it too; an in-process
 * queue where Web Locks are missing. `createWorkspaceFile` checks and writes
 * under it, so nothing lands between its check and its write.
 */
const localLocks = new Map<string, Promise<unknown>>();

function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const name = `lumen-workspace:${splitPath(path).join("/")}`;
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (locks?.request) return locks.request(name, () => fn()) as Promise<T>;
  const prev = localLocks.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  localLocks.set(name, tail);
  void tail.then(() => {
    if (localLocks.get(name) === tail) localLocks.delete(name);
  });
  return run;
}

async function writeUnlocked(path: string, data: VaultData): Promise<void> {
  await vault().write(path, data);
}

export async function writeWorkspaceFile(
  path: string,
  content: string,
): Promise<void> {
  return withPathLock(path, () => writeUnlocked(path, content));
}

/** What a file was when it was read: a write that expects it refuses if the file changed since. */
export interface FileStamp {
  size: number;
  mtime: number;
}

/** Files joined into one Blob read: about 50 notes (measured fastest on OPFS), at most 4 MB. */
const BATCH_FILES = 50;
const BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Many notes read at once (a bulk edit, plan W7.4), each with its stamp.
 * Reading a file's bytes is the slow part on OPFS (each read is its own
 * trip to the browser's storage process), while getting the File object is
 * cheap, so the files are joined into one Blob per few MB and each joined
 * Blob is read once, then split by the files' sizes. A path that can't be
 * read is missing from the result (the caller decides). Keeps a BOM, as
 * readWorkspaceFile does.
 */
export async function readWorkspaceTexts(paths: readonly string[]): Promise<Map<string, { text: string; stamp: FileStamp }>> {
  const out = new Map<string, { text: string; stamp: FileStamp }>();
  // A backend that can list each folder once (OPFS, a folder) hands over the files in one go.
  const many = await (vault().readMany?.(paths) ?? Promise.resolve(new Map<string, File>())).catch(() => new Map<string, File>());
  const got: Array<{ p: string; blob: Blob; stamp: FileStamp } | null> = [];
  // Paths the backend's batch did not cover, a few at a time (each read is a trip to storage).
  let nextPath = 0;
  const one = async (p: string) => {
    try {
      const blob = many.get(splitPath(p).join("/")) ?? (await vault().read(p));
      // A File (OPFS, a folder) carries its own size and time: no second lookup. Otherwise ask the backend.
      if (blob instanceof File && blob.lastModified) return { p, blob, stamp: { size: blob.size, mtime: blob.lastModified } };
      const st = await vault().stat(p);
      return st && st.kind === "file" && st.size === blob.size ? { p, blob, stamp: { size: st.size, mtime: st.mtime } } : null;
    } catch {
      // why: unreadable or gone: left out, and the caller says so
      return null;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(16, paths.length) }, async () => {
      while (nextPath < paths.length) {
        const i = nextPath++;
        got[i] = await one(paths[i]);
      }
    }),
  );
  const ok = got.filter((g): g is NonNullable<typeof g> => g !== null);
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  const groups: (typeof ok)[] = [];
  let bytes = Infinity;
  for (const g of ok) {
    if (bytes + g.blob.size > BATCH_BYTES || (groups[groups.length - 1]?.length ?? 0) >= BATCH_FILES) {
      groups.push([]);
      bytes = 0;
    }
    groups[groups.length - 1].push(g);
    bytes += g.blob.size;
  }
  // One joined read at a time: the reads queue in one storage process anyway.
  for (const group of groups) {
    const all = new Uint8Array(await new Blob(group.map((g) => g.blob)).arrayBuffer());
    let at = 0;
    for (const g of group) {
      out.set(g.p, { text: dec.decode(all.subarray(at, at + g.blob.size)), stamp: g.stamp });
      at += g.blob.size;
    }
  }
  return out;
}

/**
 * Write `content` only if the file is still what `expect` says (same size
 * and modification time), checked under the path's write lock. False when
 * it changed or went: nothing is written then.
 */
export async function writeWorkspaceFileIf(path: string, content: string, expect: FileStamp): Promise<boolean> {
  return withPathLock(path, async () => {
    const st = await vault().stat(path);
    if (!st || st.kind !== "file" || st.size !== expect.size || st.mtime !== expect.mtime || !expect.mtime) return false;
    await writeUnlocked(path, content);
    return true;
  });
}

/**
 * Many stamped writes at once (plan W7.4), each under its path's lock: the
 * backend's `writeMany` when it has one (each folder looked up once), else
 * writeWorkspaceFileIf one by one. Per path: true written, false changed
 * since, or the error.
 */
export async function writeWorkspaceFilesIf(items: ReadonlyArray<{ path: string; content: string; expect: FileStamp }>): Promise<Map<string, boolean | Error>> {
  const backend = vault();
  if (backend.writeMany) return backend.writeMany(items.map((i) => ({ path: i.path, data: i.content, expect: i.expect })), withPathLock);
  const out = new Map<string, boolean | Error>();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      try {
        out.set(it.path, await writeWorkspaceFileIf(it.path, it.content, it.expect));
      } catch (e) {
        out.set(it.path, e instanceof Error ? e : new Error(String(e)));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, items.length) }, worker));
  return out;
}

/** Write arbitrary binary content (e.g. an image asset). */
export async function writeWorkspaceBlob(
  path: string,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<void> {
  return withPathLock(path, () => writeUnlocked(path, data));
}

/**
 * Create a file only if nothing exists at `path`: the check and the write
 * hold the path's lock, so a write from another tab, sync or an agent can't
 * slip in between and be truncated. Resolves to false (and writes nothing)
 * when the path is taken.
 */
export async function createWorkspaceFile(path: string, content: string): Promise<boolean> {
  return withPathLock(path, async () => {
    // A lookup that fails for any reason but "not there" throws: it never
    // turns into an overwrite (workspaceHasEntry would read it as "absent").
    if ((await vault().stat(path)) !== null) return false;
    await writeUnlocked(path, content);
    return true;
  });
}

/** Read raw bytes; useful for assets resolved into blob URLs. */
export async function readWorkspaceBlob(path: string): Promise<Blob> {
  return vault().read(path);
}

const ASSET_PREFIX = "lumen-asset-";

export function isAssetName(name: string): boolean {
  return basename(name).startsWith(ASSET_PREFIX);
}

export function makeAssetName(originalName: string): string {
  const ext =
    originalName.match(/\.[A-Za-z0-9]+$/)?.[0]?.toLowerCase() ?? ".png";
  // Cryptographically-strong suffix avoids collisions even with rapid pastes.
  const stamp = `${Date.now().toString(36)}-${randomId(3)}`;
  return `${ASSET_PREFIX}${stamp}${ext}`;
}

/** Delete a file at `path` — recursively when `path` refers to a directory. */
export async function deleteWorkspaceFile(path: string): Promise<void> {
  await vault().remove(path);
}

/**
 * The file names directly in folder `path` (not recursive; dot names
 * included). Empty when the folder does not exist. For app data folders
 * such as `.lumen/mcp/pending`, which the tree listing leaves out.
 */
export async function listWorkspaceFolder(path: string): Promise<string[]> {
  try {
    return (await vault().list(path)).filter((e) => e.kind === "file").map((e) => e.name).sort();
  } catch {
    // why: a folder that does not exist (or is not a folder) has no files
    return [];
  }
}

/** Does anything (file or folder) exist at `path`? */
export async function workspaceHasEntry(path: string): Promise<boolean> {
  try {
    return (await vault().stat(path)) !== null;
  } catch {
    return false;
  }
}

/**
 * Rename or move a file or a folder (T46). Refuses to replace anything at
 * the target unless `overwrite` is set — it used to overwrite silently.
 * Folders move recursively. (OPFS names are case-sensitive, so a change of
 * letter case is an ordinary rename.)
 */
export async function renameWorkspaceFile(
  oldPath: string,
  newPath: string,
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  // Plan 2.7: outside content stays outside content under its new name. The
  // records move first: if they can't be stored, nothing is moved; if the
  // move fails (conflict, quota, write error), they go back.
  const prov = await import("../agents/provenance");
  const before = prov.snapshotRecords();
  if (oldPath !== newPath) prov.moveUntrustedNotes(oldPath, newPath);
  try {
    await vault().rename(oldPath, newPath, opts);
  } catch (e) {
    try {
      prov.restoreRecords(before);
    } catch {
      /* why: the records stay on the new name as well: outside content is never lost */
    }
    throw e;
  }
}

export async function workspaceHasFile(path: string): Promise<boolean> {
  try {
    return (await vault().stat(path))?.kind === "file";
  } catch {
    return false;
  }
}

/** Create a directory at `path` (creating intermediate dirs as needed). */
export async function createWorkspaceFolder(path: string): Promise<void> {
  await vault().mkdir(path);
}

/** Can the active vault work here? (The name predates plan 4.1: it asks the active backend, OPFS by default.) */
export function isOPFSAvailable(): boolean {
  return vault().available();
}

/**
 * Pick a unique file path inside the workspace.
 * `base` may be a basename ("Untitled.md") or a full path ("folder/foo.md").
 */
export async function uniqueWorkspaceName(base: string): Promise<string> {
  const dir = dirname(base);
  const fileBase = basename(base);
  const ext = fileBase.match(/\.[^./]+$/)?.[0] ?? ".md";
  const stem = fileBase.replace(ext, "");
  let i = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidateName = i === 0 ? `${stem}${ext}` : `${stem} ${i + 1}${ext}`;
    const candidate = dir ? `${dir}/${candidateName}` : candidateName;
    // A folder of that name blocks the file as much as a file does.
    if (!(await workspaceHasEntry(candidate))) return candidate;
    i++;
    if (i > 999) {
      const fallback = `${stem}-${Date.now()}${ext}`;
      return dir ? `${dir}/${fallback}` : fallback;
    }
  }
}
