/**
 * Workspace storage using the Origin Private File System (OPFS).
 * Files and folders are addressed by forward-slash paths, e.g.
 * `notes/2026/april.md`. Path traversal walks (creating intermediate
 * directories on demand for write paths).
 */

import { randomId } from "../lib/cryptoRandom";
import { needsSyncWriteFallback, syncWriteOpfs } from "./opfsSyncWrite";

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

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("OPFS is not available in this browser.");
  }
  return await navigator.storage.getDirectory();
}

// ── Path helpers ─────────────────────────────────────────────────────────

export function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function joinPath(...parts: string[]): string {
  return parts.flatMap(splitPath).join("/");
}

export function basename(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? "";
}

export function dirname(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return parts.join("/");
}

async function walkDir(
  parts: string[],
  opts: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandle> {
  let cur = await root();
  for (const part of parts) {
    cur = await cur.getDirectoryHandle(part, { create: !!opts.create });
  }
  return cur;
}

async function getFileHandleAt(
  path: string,
  opts: { create?: boolean } = {},
): Promise<FileSystemFileHandle> {
  const parts = splitPath(path);
  const file = parts.pop();
  if (!file) throw new Error("Empty workspace path");
  const dir = await walkDir(parts, opts);
  return await dir.getFileHandle(file, { create: !!opts.create });
}

// ── Recursive tree ───────────────────────────────────────────────────────

async function readDirInto(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  opts: { includeAssets: boolean; includeHidden: boolean },
): Promise<WorkspaceNode[]> {
  const out: WorkspaceNode[] = [];
  for await (const [name, handle] of dir.entries()) {
    // Dot entries are app data (".trash", ".obsidian"), not notes (T46):
    // hidden from the tree, search and the index. Sync callers still need
    // real repository content such as `.github/` — only the trash stays out.
    if (name.startsWith(".") && (!opts.includeHidden || (!prefix && name === ".trash"))) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      const children = await readDirInto(
        handle as FileSystemDirectoryHandle,
        path,
        opts,
      );
      // Hide entirely-empty asset-only directories when not including assets.
      out.push({ path, name, kind: "directory", children });
    } else {
      if (!opts.includeAssets && isAssetName(name)) continue;
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({
          path,
          name,
          kind: "file",
          size: file.size,
          modified: file.lastModified,
        });
      } catch {
        out.push({ path, name, kind: "file" });
      }
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Recursive tree of all entries in the workspace. */
export async function listWorkspaceTree(
  opts: { includeAssets?: boolean; includeHidden?: boolean } = {},
): Promise<WorkspaceNode[]> {
  return readDirInto(await root(), "", { includeAssets: !!opts.includeAssets, includeHidden: !!opts.includeHidden });
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

export async function readWorkspaceFile(path: string): Promise<string> {
  const handle = await getFileHandleAt(path);
  const file = await handle.getFile();
  return await file.text();
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

async function writeUnlocked(path: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<void> {
  const handle = await getFileHandleAt(path, { create: true });
  if (needsSyncWriteFallback(handle)) return syncWriteOpfs(splitPath(path), data);
  const writable = await handle.createWritable();
  await writable.write(data as FileSystemWriteChunkType);
  await writable.close();
}

export async function writeWorkspaceFile(
  path: string,
  content: string,
): Promise<void> {
  return withPathLock(path, () => writeUnlocked(path, content));
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
    if (await workspaceHasEntry(path)) return false;
    await writeUnlocked(path, content);
    return true;
  });
}

/** Read raw bytes; useful for assets resolved into blob URLs. */
export async function readWorkspaceBlob(path: string): Promise<Blob> {
  const handle = await getFileHandleAt(path);
  return await handle.getFile();
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
  const parts = splitPath(path);
  const last = parts.pop();
  if (!last) throw new Error("Cannot delete the workspace root");
  const parent = await walkDir(parts);
  await parent.removeEntry(last, { recursive: true });
}

/** A rename / move would replace an existing file or folder. */
export class WorkspaceConflictError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" already exists`);
    this.name = "WorkspaceConflictError";
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await walkDir(splitPath(path));
    return true;
  } catch {
    return false;
  }
}

/** Does anything (file or folder) exist at `path`? */
export async function workspaceHasEntry(path: string): Promise<boolean> {
  return (await workspaceHasFile(path)) || (await isDirectory(path));
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
  if (oldPath === newPath) return;
  if (newPath.startsWith(oldPath + "/")) throw new Error(`Cannot move "${oldPath}" into itself`);
  const existed = await workspaceHasEntry(newPath);
  if (!opts.overwrite && existed) throw new WorkspaceConflictError(newPath);
  try {
    if (await isDirectory(oldPath)) {
      await copyTree(oldPath, newPath);
    } else {
      const original = await readWorkspaceBlob(oldPath);
      await writeWorkspaceBlob(newPath, original);
    }
  } catch (e) {
    // A copy that failed half way (quota, write error) must not leave a
    // partial tree at the target: it would block a retry, or sit at the
    // name of an original that a replace moved to the trash.
    if (!existed) await deleteWorkspaceFile(newPath).catch(() => undefined);
    throw e;
  }
  await deleteWorkspaceFile(oldPath);
}

async function copyTree(from: string, to: string): Promise<void> {
  const dir = await walkDir(splitPath(from));
  await createWorkspaceFolder(to);
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "directory") await copyTree(`${from}/${name}`, `${to}/${name}`);
    else await writeWorkspaceBlob(`${to}/${name}`, await (handle as FileSystemFileHandle).getFile());
  }
}

export async function workspaceHasFile(path: string): Promise<boolean> {
  try {
    await getFileHandleAt(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a directory at `path` (creating intermediate dirs as needed). */
export async function createWorkspaceFolder(path: string): Promise<void> {
  const parts = splitPath(path);
  if (parts.length === 0) return;
  await walkDir(parts, { create: true });
}

export function isOPFSAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
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
