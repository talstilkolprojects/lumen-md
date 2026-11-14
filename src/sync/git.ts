/**
 * Git sync via `isomorphic-git`.
 *
 * Strategy: keep the git working copy in a `lightning-fs` (IndexedDB) volume
 * mounted at `/git/<repo>`. After a clone we copy the files into the vault
 * under the same folder so they show up in the workspace tree. Commit / push
 * copy the vault's content back into lightning-fs so users can edit locally
 * and push when ready. A pull merges three ways into the vault and never
 * deletes (plan 3.3, src/sync/gitPull.ts). Public repositories need no
 * token; a CORS proxy is configurable (src/sync/gitProxy.ts). Git LFS is
 * not supported: pointer files are detected and reported, never written over
 * real files.
 */
import { get, set } from "idb-keyval";
import {
  createWorkspaceFolder,
  listWorkspace,
  readWorkspaceBlob,
  workspaceHasEntry,
  writeWorkspaceBlob,
} from "../storage/workspace";
import { getSecret, setSecret, initSecretStore, flushSecrets } from "../lib/secretStore";
import { hasConflictMarkers, isLfsPointer } from "./gitMerge";
import { integrateFetched, type PendingConflict, type PullGit, type SafePullResult } from "./gitPull";
import { authFor, getCorsProxy } from "./gitProxy";
import { writeIntoMirror } from "./gitMirror";
import { getVaultBackend } from "../storage/vault";

type Fs = {
  promises: {
    readFile: (path: string, opts?: unknown) => Promise<Uint8Array | string>;
    writeFile: (path: string, data: Uint8Array | string) => Promise<void>;
    mkdir: (path: string, opts?: unknown) => Promise<void>;
    readdir: (path: string) => Promise<string[]>;
    stat: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
    unlink?: (path: string) => Promise<void>;
  };
};

/**
 * `git` exposes a wide surface — for our needs we use clone, commit, push,
 * pull, and addRemote. Defining a small structural type keeps us from having
 * to import the package's full type bundle eagerly.
 */
interface IsomorphicGit extends PullGit {
  clone: (opts: Record<string, unknown>) => Promise<void>;
  fetch: (opts: Record<string, unknown>) => Promise<{ fetchHead: string | null }>;
  push: (opts: Record<string, unknown>) => Promise<unknown>;
  add: (opts: Record<string, unknown>) => Promise<void>;
  commit: (opts: Record<string, unknown>) => Promise<string>;
  statusMatrix: (opts: Record<string, unknown>) => Promise<unknown[][]>;
  listFiles: (opts: Record<string, unknown>) => Promise<string[]>;
}

let fsPromise: Promise<{ fs: Fs; http: unknown; git: IsomorphicGit }> | null = null;

async function load() {
  if (!fsPromise) {
    fsPromise = (async () => {
      // isomorphic-git uses Node's Buffer (index, packfiles); browsers have
      // none, so it is provided before isomorphic-git loads.
      const g = globalThis as unknown as { Buffer?: unknown };
      if (!g.Buffer) g.Buffer = (await import("buffer")).Buffer;
      const [LFS, isoGit, http] = await Promise.all([
        import("@isomorphic-git/lightning-fs").then((m) => m.default),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        import("isomorphic-git") as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        import("isomorphic-git/http/web") as Promise<any>,
      ]);
      // LFS's default export is a class — its TS types declare the
      // constructor's `name` parameter as `string` but the value comes
      // through as a generic constructor. Cast through `unknown` to a
      // typed `new`-able to keep the call site honest.
      const FsCtor = LFS as unknown as new (name: string) => Fs;
      const fs = new FsCtor("lumen-git");
      return { fs, http: http.default ?? http, git: isoGit.default ?? isoGit };
    })();
  }
  return fsPromise;
}

const TOKEN_KEY = "lumen.git.token.v1";

export async function setGitToken(token: string | null): Promise<void> {
  await initSecretStore();
  setSecret(TOKEN_KEY, token || null);
  await flushSecrets();
}

export async function getGitToken(): Promise<string> {
  await initSecretStore();
  return getSecret(TOKEN_KEY) ?? "";
}

function repoNameFromUrl(url: string): string {
  const m = url.match(/[/:]([^/:]+?)(?:\.git)?\/?$/);
  return m?.[1] ?? "repo";
}

/**
 * The file's bytes in the vault, or null when nothing is there. A read that
 * fails rejects: it must never pass for "absent" — a pull would then write
 * over the file, a commit would drop it.
 */
async function readVaultBytes(path: string): Promise<Uint8Array | null> {
  const st = await getVaultBackend().stat(path);
  if (!st || st.kind !== "file") return null;
  return new Uint8Array(await (await readWorkspaceBlob(path)).arrayBuffer());
}

async function vaultKind(path: string): Promise<"file" | "directory" | null> {
  return (await getVaultBackend().stat(path))?.kind ?? null;
}

// ── Conflicts left for later (plan 3.3) ──────────────────────────────────
// A conflict the user chose to "resolve later" stays in its file between
// markers. The pull already advanced the mirror, so it is remembered here:
// the next pull offers it again, and commit refuses while its markers are
// still in the file (only for files a pull marked — a note that merely shows
// conflict markers as an example is never blocked).

const CONFLICTS_KEY = (repoFolder: string) => `lumen.git.conflicts.v1:${repoFolder}`;

export async function getPendingConflicts(repoFolder: string): Promise<PendingConflict[]> {
  const v = (await get(CONFLICTS_KEY(repoFolder))) as PendingConflict[] | undefined;
  return Array.isArray(v) ? v : [];
}

export async function setPendingConflicts(repoFolder: string, conflicts: PendingConflict[]): Promise<void> {
  await set(CONFLICTS_KEY(repoFolder), conflicts);
}

/**
 * The remembered conflicts that are still open: a marked file that still
 * holds its markers, or an open-note conflict whose copy of the remote
 * version is still there (its "mine" is refreshed to what the note holds
 * now). A read that fails rejects — it never counts as "resolved".
 */
async function stillConflicted(repoFolder: string): Promise<PendingConflict[]> {
  const out: PendingConflict[] = [];
  const dec = new TextDecoder();
  for (const c of await getPendingConflicts(repoFolder)) {
    if (c.where === "file") {
      const bytes = await readVaultBytes(c.path);
      if (bytes && hasConflictMarkers(dec.decode(bytes))) out.push(c);
      continue;
    }
    if (!c.copy || !(await readVaultBytes(c.copy))) continue;
    const { pullEditorHooks } = await import("../store/gitPullDocs");
    const note = pullEditorHooks().openNote(c.path);
    const file = await readVaultBytes(c.path);
    const ours = note ? note.content : file ? dec.decode(file) : null;
    if (ours !== null) out.push({ ...c, ours });
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Copy the checked-out tree from lightning-fs into the vault folder
 * `vaultFolder`. Never replaces a file the vault already has (cloning into
 * a folder that is already in use keeps every local file, plan 3.3).
 */
async function mirrorRepoToVault(repoDir: string, fs: Fs, vaultFolder: string): Promise<{ written: number; kept: string[]; lfsPointers: string[] }> {
  let written = 0;
  const kept: string[] = [];
  const lfsPointers: string[] = [];
  async function walk(dir: string, vaultPrefix: string) {
    const entries = await fs.promises.readdir(dir);
    for (const entry of entries) {
      if (entry === ".git") continue;
      const full = `${dir}/${entry}`;
      const stat = await fs.promises.stat(full);
      const vaultPath = `${vaultPrefix}/${entry}`;
      if (stat.isDirectory()) {
        // A file of that name here: keep it, and leave this subtree out.
        if ((await vaultKind(vaultPath)) === "file") {
          kept.push(vaultPath);
          continue;
        }
        await createWorkspaceFolder(vaultPath);
        await walk(full, vaultPath);
      } else if (stat.isFile()) {
        const bytes = (await fs.promises.readFile(full)) as Uint8Array;
        if (isLfsPointer(bytes)) lfsPointers.push(vaultPath);
        const existing = await readVaultBytes(vaultPath);
        if (existing) {
          if (!sameBytes(existing, bytes)) kept.push(vaultPath);
          continue;
        }
        if (await workspaceHasEntry(vaultPath)) {
          kept.push(vaultPath); // a folder of that name: leave it
          continue;
        }
        await writeWorkspaceBlob(vaultPath, bytes);
        written++;
      }
    }
  }
  if ((await vaultKind(vaultFolder)) === "file") throw new Error(`"${vaultFolder}" is a file in the vault; clone into another folder.`);
  await createWorkspaceFolder(vaultFolder);
  await walk(repoDir, vaultFolder);
  return { written, kept, lfsPointers };
}

export interface CloneResult {
  /** Workspace folder where the files were placed. */
  workspaceFolder: string;
  /** Number of files copied. */
  fileCount: number;
  /** Files the vault already had with other content: kept, not overwritten. */
  kept: string[];
  /** Git LFS pointer files (LFS is not supported: the real content is not downloaded). */
  lfsPointers: string[];
}

/**
 * Clone a repository into lightning-fs and copy its files into the vault.
 * Public repositories need no token; requests go through the configured
 * CORS proxy (src/sync/gitProxy.ts).
 */
export async function cloneRepo(
  url: string,
  opts: { branch?: string; token?: string; depth?: number; corsProxy?: string } = {},
): Promise<CloneResult> {
  const { fs, http, git } = await load();
  const name = repoNameFromUrl(url);
  const dir = `/git/${name}`;
  // Ensure parent and target dirs exist.
  try {
    await fs.promises.mkdir("/git");
  } catch {
    /* exists */
  }
  try {
    await fs.promises.mkdir(dir);
  } catch {
    /* exists */
  }

  const token = opts.token ?? (await getGitToken());
  await git.clone({
    fs,
    http,
    dir,
    url,
    ref: opts.branch,
    depth: opts.depth ?? 1,
    singleBranch: true,
    corsProxy: opts.corsProxy ?? getCorsProxy(),
    ...authFor(token),
  });

  const { written, kept, lfsPointers } = await mirrorRepoToVault(dir, fs, name);
  return { workspaceFolder: name, fileCount: written, kept, lfsPointers };
}

/** Commit refused: these files still hold conflict markers from a pull. */
export class UnresolvedConflictsError extends Error {
  constructor(readonly paths: string[]) {
    super(`Unresolved conflicts in: ${paths.join(", ")}`);
    this.name = "UnresolvedConflictsError";
  }
}

/**
 * Push every workspace file under `<repoFolder>/` back into the lightning-fs
 * checkout, commit, and push to origin. `repoFolder` must match a previous
 * clone target.
 */
export interface CommitResult {
  /** Vault paths left out: the repository has a folder where the vault has a file, or the reverse. */
  skipped: string[];
  /** Vault paths committed as the repository's LFS pointer, not as the real file the vault holds (Git LFS is not supported). */
  lfsKept: string[];
  /** Open notes with edits that could not be saved first (a change made outside Lumen is being resolved): left out of this commit. */
  unsaved: string[];
}

export async function commitAndPush(
  repoFolder: string,
  message: string,
  author: { name: string; email: string },
  opts: { token?: string; branch?: string; flushOpenNotes?: () => Promise<string[]> } = {},
): Promise<CommitResult> {
  const { fs, http, git } = await load();
  const dir = `/git/${repoFolder}`;
  // Every open note with edits is saved first (Codex P1 on #269): a pull puts a
  // merge into an inactive dirty tab, and autosave writes only the active
  // note, so the vault — what the commit reads — would still hold the old
  // text while the mirror already has upstream's. A note that cannot be
  // saved (an outside change is being resolved) stays out of this commit.
  const flush = opts.flushOpenNotes ?? (await import("../store/gitPullDocs")).flushOpenNotes;
  const unsaved = new Set((await flush()).filter((p) => p.startsWith(`${repoFolder}/`)));
  // Mirror the vault → lightning-fs (only files under the repo's prefix),
  // as bytes: images and other binary files go through unchanged.
  const all = await listWorkspace({ includeAssets: true, includeHidden: true });
  const prefix = `${repoFolder}/`;
  const repoFiles = all.filter((f) => f.path.startsWith(prefix) && !unsaved.has(f.path));
  // A pull left conflict markers: committing them would publish them.
  const pending = await stillConflicted(repoFolder);
  await setPendingConflicts(repoFolder, pending);
  if (pending.length) throw new UnresolvedConflictsError(pending.map((c) => c.path));
  const files: Array<{ relative: string; bytes: Uint8Array }> = [];
  for (const f of repoFiles) {
    const bytes = await readVaultBytes(f.path);
    if (!bytes) continue;
    files.push({ relative: f.path.slice(prefix.length), bytes });
  }
  // A path whose shape differs in the mirror (file vs folder, kept that way
  // by a clone into an existing folder) is skipped and reported, never forced;
  // an LFS pointer in the mirror stays a pointer (the vault's real file is
  // never committed as a blob).
  const written = await writeIntoMirror(fs, dir, files);
  const skipped = written.skipped.map((r) => prefix + r);
  const lfsKept = written.lfsKept.map((r) => prefix + r);
  // Stage everything and commit.
  await git.add({ fs, dir, filepath: "." });
  await git.commit({
    fs,
    dir,
    message,
    author: { name: author.name, email: author.email },
  });
  // Push.
  const token = opts.token ?? (await getGitToken()) ?? "";
  if (!token) {
    throw new Error(
      "Missing GitHub token. Set one via the command palette: Git → Set token.",
    );
  }
  await git.push({
    fs,
    http,
    dir,
    ref: opts.branch,
    corsProxy: getCorsProxy(),
    ...authFor(token),
  });
  return { skipped, lfsKept, unsaved: [...unsaved] };
}

export interface GitStatusEntry {
  path: string;
  state: "unmodified" | "modified" | "added" | "deleted";
}

export async function gitStatus(repoFolder: string): Promise<GitStatusEntry[]> {
  const { fs, git } = await load();
  const dir = `/git/${repoFolder}`;
  // First mirror OPFS → lightning-fs so the status reflects current edits —
  // through the same copy a commit uses, so a shape clash is skipped rather
  // than failing the status, and an LFS pointer in the mirror stays one.
  const all = await listWorkspace({ includeAssets: true, includeHidden: true });
  const prefix = `${repoFolder}/`;
  const files: Array<{ relative: string; bytes: Uint8Array }> = [];
  for (const f of all) {
    if (!f.path.startsWith(prefix)) continue;
    const bytes = await readVaultBytes(f.path);
    if (bytes) files.push({ relative: f.path.slice(prefix.length), bytes });
  }
  await writeIntoMirror(fs, dir, files);
  const matrix = (await git.statusMatrix({ fs, dir })) as [
    string,
    number,
    number,
    number,
  ][];
  const out: GitStatusEntry[] = [];
  for (const [filepath, head, workdir] of matrix) {
    let state: GitStatusEntry["state"] = "unmodified";
    if (head === 0 && workdir === 2) state = "added";
    else if (head === 1 && workdir === 0) state = "deleted";
    else if (head === 1 && workdir === 2) state = "modified";
    out.push({ path: `${repoFolder}/${filepath}`, state });
  }
  return out;
}

/** Useful when the user wants to point Lumen at a specific identity. */
export interface GitIdentity {
  name: string;
  email: string;
}

const IDENTITY_KEY = "lumen.git.identity.v1";

export async function setGitIdentity(id: GitIdentity): Promise<void> {
  await set(IDENTITY_KEY, id);
}

export async function getGitIdentity(): Promise<GitIdentity> {
  const v = (await get(IDENTITY_KEY)) as GitIdentity | undefined;
  return v ?? { name: "Lumen User", email: "lumen@example.invalid" };
}

export type PullResult = SafePullResult;
export type { PendingConflict };

/** How a pull reaches the open notes (src/store/gitPullDocs.ts in the app; tests pass their own). */
export interface PullEditorHooks {
  openNote(path: string): { content: string; dirty: boolean } | null;
  setOpenNote(path: string, text: string): void;
  onWritten(path: string, text: string | null): void;
}

/** Fetch with this depth (relative) to deepen a shallow clone; this one means "all of it". */
const FULL_DEPTH = 2147483647;

/**
 * Safe pull (plan 3.3): fetch, then a three-way merge into the vault
 * (src/sync/gitPull.ts). Nothing is deleted, untracked files are not
 * touched, a note open with unsaved edits is never overwritten, and
 * overlapping edits come back as `conflicts` for the resolution screen.
 * A shallow clone is deepened until the merge base is found.
 */
export async function pullRepo(
  repoFolder: string,
  opts: { token?: string; branch?: string; author?: GitIdentity; corsProxy?: string; editor?: PullEditorHooks } = {},
): Promise<PullResult> {
  const { fs, http, git } = await load();
  const dir = `/git/${repoFolder}`;
  const token = opts.token ?? (await getGitToken());
  const author = opts.author ?? (await getGitIdentity());
  const branch = opts.branch ?? (((await git.currentBranch({ fs, dir, fullname: false })) as string | undefined) || undefined);
  const net = { fs, http, dir, corsProxy: opts.corsProxy ?? getCorsProxy(), ref: branch, singleBranch: true, ...authFor(token) };
  const fetched = await git.fetch(net);
  const head = (await git.resolveRef({ fs, dir, ref: "HEAD" })) as string;
  const theirs = fetched.fetchHead;
  if (!theirs) {
    return {
      changedFiles: 0,
      deletedFiles: 0,
      upToDate: true,
      conflicts: await stillConflicted(repoFolder),
      keptDeletedUpstream: [],
      lfsSkipped: [],
      lfsPointers: [],
      copies: [],
      mergedIntoOpen: [],
      kindClashes: [],
      head,
    };
  }
  return integrateIntoVault(repoFolder, theirs, {
    author,
    editor: opts.editor,
    deepen: async ({ depth, full }) => {
      if (full) {
        await git.fetch({ ...net, depth: FULL_DEPTH });
        return;
      }
      try {
        await git.fetch({ ...net, depth, relative: true });
      } catch {
        // A server without deepen-relative: ask for that much history from the tip.
        await git.fetch({ ...net, depth });
      }
    },
  });
}

/**
 * The merge half of a pull: bring commit `theirs` (already in the local
 * repository, e.g. just fetched) into the vault folder `repoFolder`.
 */
export async function integrateIntoVault(
  repoFolder: string,
  theirs: string,
  opts: { author?: GitIdentity; editor?: PullEditorHooks; deepen?: (step: { depth: number; full: boolean }) => Promise<void> } = {},
): Promise<PullResult> {
  const { fs, git } = await load();
  const author = opts.author ?? (await getGitIdentity());
  const editor = opts.editor ?? (await import("../store/gitPullDocs")).pullEditorHooks();
  const earlier = await stillConflicted(repoFolder);
  const result = await integrateFetched({
    git,
    fs,
    dir: `/git/${repoFolder}`,
    repoFolder,
    theirs,
    author: { name: author.name, email: author.email },
    deepen: opts.deepen,
    vault: {
      read: readVaultBytes,
      write: (path, data) => writeWorkspaceBlob(path, data),
      exists: workspaceHasEntry,
      kind: vaultKind,
    },
    openNote: (path) => editor.openNote(path),
    setOpenNote: (path, text) => editor.setOpenNote(path, text),
    onWritten: (path, text) => editor.onWritten(path, text),
    snapshot: async (path, text) => {
      const { recordSnapshot } = await import("../storage/history");
      await recordSnapshot(path, text, "git-pull").catch(() => false);
    },
  });
  // Conflicts left from an earlier pull come back with the new ones (a new
  // conflict on the same file replaces the old record).
  const fresh = new Set(result.conflicts.map((c) => c.path));
  result.conflicts = [...earlier.filter((c) => !fresh.has(c.path)), ...result.conflicts];
  await setPendingConflicts(repoFolder, result.conflicts);
  return result;
}

/** @internal e2e (dev server) and tests: the git runtime (lightning-fs + isomorphic-git). */
export async function __gitRuntime(): Promise<{ fs: unknown; git: unknown }> {
  const { fs, git } = await load();
  return { fs, git };
}

export interface GitStatusSummary {
  added: number;
  modified: number;
  deleted: number;
  entries: GitStatusEntry[];
}

export async function gitStatusSummary(
  repoFolder: string,
): Promise<GitStatusSummary> {
  const entries = await gitStatus(repoFolder);
  const summary: GitStatusSummary = {
    added: 0,
    modified: 0,
    deleted: 0,
    entries,
  };
  for (const e of entries) {
    if (e.state === "added") summary.added++;
    else if (e.state === "modified") summary.modified++;
    else if (e.state === "deleted") summary.deleted++;
  }
  return summary;
}
