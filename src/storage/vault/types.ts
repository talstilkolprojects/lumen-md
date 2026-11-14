/**
 * The vault layer (plan 4.1): one interface between Lumen and wherever the
 * user's notes are stored.
 *
 * Today the notes live in the browser's Origin Private File System (OPFS);
 * tomorrow they can live in a real folder — a FileSystemDirectoryHandle the
 * user picked in Chromium (plan 4.3) or the desktop file system through
 * Tauri (plan 4.2) — and safe git (3.3) and encryption (11.4) sit on top of
 * the same calls. Everything that reads or writes vault files goes through
 * a `VaultBackend`: the workspace module (src/storage/workspace.ts keeps its
 * public functions as thin wrappers over the active backend), and through it
 * the index, the file tree, git, embeddings, search, export, trash and the
 * canvases. Only the backend implementations under src/storage/vault/ touch
 * the browser's file-system handles; `npm run hygiene` enforces that.
 *
 * Paths are forward-slash, relative to the vault root, without a leading
 * slash (`notes/2026/april.md`); "" is the root. Empty segments are ignored
 * (`a//b` = `a/b`), `.` and `..` segments are refused, so no path can leave
 * the vault. Names are case-sensitive and compared as given (no Unicode
 * normalisation).
 *
 * Every backend must pass the contract suite in
 * src/__tests__/vaultBackend.contract.test.ts.
 */

export type VaultEntryKind = "file" | "directory";

export interface VaultStat {
  kind: VaultEntryKind;
  /** Size in bytes; 0 for a directory (and for a file that cannot be read right now). */
  size: number;
  /** Last modification, ms since the epoch; 0 when the backend cannot tell (directories on OPFS). */
  mtime: number;
}

/** One direct child of a directory, as `list()` returns it. */
export interface VaultEntry {
  /** Basename. */
  name: string;
  /** Path relative to the vault root. */
  path: string;
  kind: VaultEntryKind;
  /** Files: size in bytes, when the backend could read it. */
  size?: number;
  /** Files: last modification (ms since the epoch), when the backend could read it. */
  mtime?: number;
}

/** What `write()` accepts: text (stored as UTF-8) or bytes. */
export type VaultData = string | Blob | ArrayBuffer | Uint8Array;

export type VaultEventType = "write" | "mkdir" | "delete" | "rename";

export interface VaultEvent {
  type: VaultEventType;
  /** The path written / created / deleted; for a rename, the new path. */
  path: string;
  /** Rename only: where the entry was. */
  from?: string;
  /**
   * "self": this backend made the change (an own write).
   * "external": the storage changed behind the backend's back — another
   * tab, an editor working on the real folder, a git checkout — and a
   * platform watcher (FileSystemObserver, Tauri fs watch) or a caller of
   * `notifyExternal()` reported it.
   */
  origin: "self" | "external";
}

export type VaultListener = (event: VaultEvent) => void;

export interface VaultBackend {
  /** Short identifier ("opfs", "memory", "folder", "tauri"…), for logs and diagnostics. */
  readonly id: string;
  /** Can this backend work in the current environment (e.g. does the browser have OPFS)? */
  available(): boolean;
  /**
   * The direct children of directory `dir` ("" = the root), directories
   * first, then files, each group by name (`compareVaultEntries`). Dot
   * entries are included: hiding app data (`.trash/`) is the caller's policy.
   * Rejects with `VaultNotFoundError` when `dir` is not a directory.
   */
  list(dir: string): Promise<VaultEntry[]>;
  /** Kind, size and mtime of `path`, or null when nothing is there. */
  stat(path: string): Promise<VaultStat | null>;
  /** The bytes of the file at `path`. Rejects with `VaultNotFoundError` when it is not a file. */
  read(path: string): Promise<Blob>;
  /** The file at `path` decoded as UTF-8. Rejects with `VaultNotFoundError` when it is not a file. */
  readText(path: string): Promise<string>;
  /**
   * Create or replace the file at `path`, creating missing parent folders.
   * Rejects with `VaultError` code "EKIND" when a folder is at `path` or a
   * file is where a parent folder should be.
   */
  write(path: string, data: VaultData): Promise<void>;
  /** Create the folder at `path` and any missing parents; a no-op when it exists. "EKIND" when a file is in the way. */
  mkdir(path: string): Promise<void>;
  /**
   * Rename or move a file or a folder (folders move with everything inside).
   * Refuses to replace what is at `to` (`WorkspaceConflictError`) unless
   * `overwrite` is set; refuses to move a folder into itself, or to replace a folder
   * with something inside it ("EINVAL").
   * A move that fails half way leaves nothing partial at `to` and the
   * source untouched (with `overwrite`, a replaced folder may already be
   * gone by then — overwrite is destructive by request).
   * Rejects with `VaultNotFoundError` when nothing is at `from`.
   */
  rename(from: string, to: string, opts?: { overwrite?: boolean }): Promise<void>;
  /** Delete the file or folder (recursively) at `path`. `VaultNotFoundError` when nothing is there. */
  remove(path: string): Promise<void>;
  /**
   * Subscribe to changes. A backend fires `origin: "self"` for each write,
   * mkdir, delete and rename it completes (one "rename" event for a whole
   * folder move, never the copies inside it), and `origin: "external"` for
   * changes a platform watcher reports. Returns the unsubscribe function.
   */
  watch(listener: VaultListener): () => void;
  /**
   * The external-change hook: whoever learns that the storage changed
   * behind the backend's back reports it here, and watchers receive it
   * with `origin: "external"`.
   */
  notifyExternal(event: Omit<VaultEvent, "origin">): void;
}

export type VaultErrorCode =
  /** Nothing (or not the expected kind) at the path. */
  | "ENOENT"
  /** Something already at the target of a rename. */
  | "EEXIST"
  /** A file where a folder is needed, or a folder where a file is needed. */
  | "EKIND"
  /** A path the vault refuses (`..`, the root where an entry is needed, a folder into itself). */
  | "EINVAL";

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `${code}: "${path}"`);
    this.name = "VaultError";
  }
}

/** Nothing at the path — the vault's ENOENT. Named like OPFS's DOMException. */
export class VaultNotFoundError extends VaultError {
  constructor(path: string) {
    super("ENOENT", path, `"${path}" not found`);
    this.name = "NotFoundError";
  }
}

/** A rename / move would replace an existing file or folder. */
export class WorkspaceConflictError extends VaultError {
  constructor(path: string) {
    super("EEXIST", path, `"${path}" already exists`);
    this.name = "WorkspaceConflictError";
  }
}
