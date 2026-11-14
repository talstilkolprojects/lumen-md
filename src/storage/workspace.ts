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
import { getVaultBackend, VaultNotFoundError, type VaultEntry } from "./vault";
import { basename, dirname } from "./vault/shared";

export { basename, dirname, joinPath, splitPath } from "./vault/shared";
export { WorkspaceConflictError } from "./vault/types";
export type { VaultEntry } from "./vault/types";

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
  return vault().readText(path);
}

export async function writeWorkspaceFile(
  path: string,
  content: string,
): Promise<void> {
  await vault().write(path, content);
}

/** Write arbitrary binary content (e.g. an image asset). */
export async function writeWorkspaceBlob(
  path: string,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<void> {
  await vault().write(path, data);
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
  await vault().rename(oldPath, newPath, opts);
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
