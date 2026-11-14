/**
 * Safe git pull (plan 3.3): bring a fetched commit into the vault without
 * losing anything.
 *
 * The git working copy (lightning-fs, `/git/<repo>`) is only a mirror; the
 * vault is where the user's text lives — edited notes, files git never
 * tracked, notes open with unsaved edits. So the pull works on the vault:
 *
 *  1. find the merge base of HEAD and the fetched commit, deepening a
 *     shallow clone until there is one (`deepen`);
 *  2. list the files the remote changed between the base and its commit
 *     (nothing else is looked at: untracked files are never touched);
 *  3. per file, three-way plan (gitMerge.ts) against what the vault holds —
 *     or, for a note open with unsaved edits, against the editor's text;
 *  4. carry it out: writes, merges, conflict markers. A note open with
 *     unsaved edits is never written: a clean merge goes into the editor (still
 *     unsaved), a conflict is left to the resolution screen and the other
 *     version is kept as a copy. Nothing is ever deleted;
 *  5. record the merge in the git mirror (a merge commit when there are
 *     local commits, else a fast-forward), so the next push is a
 *     fast-forward and the next pull starts from the right base.
 *
 * Every dependency is injected, so the whole flow runs in tests against a
 * real isomorphic-git repository and an in-memory vault.
 */
import { copyPathFor, planPull, type Bytes, type MergeLabels, type PullAction, type PullEntry } from "./gitMerge";

type Call = (opts: Record<string, unknown>) => Promise<unknown>;

/** The part of isomorphic-git the pull uses. */
export interface PullGit {
  findMergeBase: Call;
  walk: Call;
  TREE: (opts: { ref: string }) => unknown;
  readBlob: Call;
  resolveRef: Call;
  currentBranch: Call;
  merge: Call;
  checkout: Call;
  writeRef: Call;
  readCommit: Call;
  commit: Call;
}

/** One entry `git.walk` hands to `map`. */
interface WalkerEntry {
  type(): Promise<string>;
  oid(): Promise<string | undefined>;
}

export interface OpenNote {
  content: string;
  dirty: boolean;
}

export interface PullDeps {
  git: PullGit;
  fs: unknown;
  /** The git working copy, e.g. `/git/notes`. */
  dir: string;
  /** The vault folder the repository is mirrored to, e.g. `notes`. */
  repoFolder: string;
  /** The fetched commit to bring in. */
  theirs: string;
  /** Fetch more history (a shallow clone). `depth` is relative; `full` asks for everything. */
  deepen?: (step: { depth: number; full: boolean }) => Promise<void>;
  vault: {
    /**
     * The file's bytes, or null when nothing is there. Rejects when the file
     * cannot be read right now: a read error must never pass for "absent"
     * (the pull would then write over the file).
     */
    read(path: string): Promise<Bytes | null>;
    write(path: string, data: Bytes): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** What is at `path`: a file, a folder, or nothing. */
    kind(path: string): Promise<"file" | "directory" | null>;
  };
  /** The note open at this vault path (after flushing pending edits), or null. */
  openNote(path: string): OpenNote | null;
  /** A clean open note's file was rewritten by the pull: show the new text. */
  onWritten?(path: string, text: string | null): void;
  /** Put merged text into an open note with unsaved edits (it stays unsaved). */
  setOpenNote?(path: string, text: string): void;
  /** Keep the vault's version in the history before the pull replaces it. */
  snapshot?(path: string, text: string): Promise<void>;
  author: { name: string; email: string };
  labels?: MergeLabels;
}

/** A conflict the user resolves on the resolution screen. */
export interface PendingConflict {
  /** Vault path. */
  path: string;
  base: string;
  ours: string;
  theirs: string;
  /** "file": the vault file holds the version with conflict markers; "open": the note is open with unsaved edits and untouched. */
  where: "file" | "open";
  /** Where the other version was kept as a copy (the "open" case). */
  copy?: string;
}

export interface SafePullResult {
  /** Files written in the vault (merged, updated, added). */
  changedFiles: number;
  /** Always 0: a pull never deletes. */
  deletedFiles: 0;
  /** Already up to date. */
  upToDate: boolean;
  conflicts: PendingConflict[];
  /** Deleted upstream, kept here. */
  keptDeletedUpstream: string[];
  /** Upstream has a Git LFS pointer; the vault file was kept. */
  lfsSkipped: string[];
  /** LFS pointers written (new files): the real content is not downloaded. */
  lfsPointers: string[];
  /** Copies made so that no version is lost (binary conflicts, open notes in conflict). */
  copies: string[];
  /** Notes open with unsaved edits that received a clean merge in the editor. */
  mergedIntoOpen: string[];
  /**
   * Upstream turned a file into a folder (or the reverse) where the vault
   * still has the other kind: left as it is here, reported.
   */
  kindClashes: string[];
  /** The commit HEAD points to now. */
  head: string;
}

export class NoMergeBaseError extends Error {
  constructor() {
    super("The local and remote histories have no common commit.");
    this.name = "NoMergeBaseError";
  }
}

/** Relative depths to deepen a shallow clone by before asking for the full history. */
export const DEEPEN_STEPS = [50, 500, 5000];

async function mergeBase(d: PullDeps, ours: string): Promise<string> {
  const find = async () => (await d.git.findMergeBase({ fs: d.fs, dir: d.dir, oids: [ours, d.theirs] })) as string[];
  let bases = await find();
  if (bases.length === 0 && d.deepen) {
    for (const depth of DEEPEN_STEPS) {
      await d.deepen({ depth, full: false });
      bases = await find();
      if (bases.length) break;
    }
    if (!bases.length) {
      await d.deepen({ depth: 0, full: true });
      bases = await find();
    }
  }
  if (!bases.length) throw new NoMergeBaseError();
  return bases[0];
}

interface Changed {
  path: string;
  base: string | null;
  theirs: string | null;
}

/** Files (blobs) whose content differs between two commits. */
async function changedBetween(d: PullDeps, a: string, b: string): Promise<Changed[]> {
  const out = (await d.git.walk({
    fs: d.fs,
    dir: d.dir,
    trees: [d.git.TREE({ ref: a }), d.git.TREE({ ref: b })],
    map: async (filepath: string, entries: Array<WalkerEntry | null>) => {
      if (filepath === ".") return undefined;
      const [ea, eb] = entries;
      const ta = ea ? await ea.type() : null;
      const tb = eb ? await eb.type() : null;
      const oa = ea ? await ea.oid() : undefined;
      const ob = eb ? await eb.oid() : undefined;
      // Identical subtree: nothing below changed, do not descend.
      if (ta === "tree" && tb === "tree" && oa === ob) return null;
      const blobA = ta === "blob" ? (oa ?? null) : null;
      const blobB = tb === "blob" ? (ob ?? null) : null;
      if (blobA === blobB) return undefined;
      return { path: filepath, base: blobA, theirs: blobB } satisfies Changed;
    },
  })) as Array<Changed | undefined> | undefined;
  return (out ?? []).filter((c): c is Changed => !!c && typeof c === "object" && "path" in c);
}

async function blob(d: PullDeps, oid: string | null): Promise<Bytes | null> {
  if (!oid) return null;
  const r = (await d.git.readBlob({ fs: d.fs, dir: d.dir, oid })) as { blob: Uint8Array };
  return r.blob;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Would writing a file at `vp` meet a folder there, or a file where one of its parent folders should be? */
async function kindClash(d: PullDeps, vp: string): Promise<boolean> {
  if ((await d.vault.kind(vp)) === "directory") return true;
  const parts = vp.split("/");
  for (let i = 1; i < parts.length; i++) {
    if ((await d.vault.kind(parts.slice(0, i).join("/"))) === "file") return true;
  }
  return false;
}

async function freeCopyPath(d: PullDeps, path: string, label: string): Promise<string> {
  let candidate = copyPathFor(path, label);
  for (let n = 2; await d.vault.exists(candidate); n++) candidate = copyPathFor(path, `${label} ${n}`);
  return candidate;
}

/**
 * Bring the fetched commit `deps.theirs` into the vault (see the module
 * comment). Throws `NoMergeBaseError` when the histories share nothing.
 */
export async function integrateFetched(d: PullDeps): Promise<SafePullResult> {
  const branch = ((await d.git.currentBranch({ fs: d.fs, dir: d.dir, fullname: false })) as string | undefined) ?? "HEAD";
  const ours = (await d.git.resolveRef({ fs: d.fs, dir: d.dir, ref: "HEAD" })) as string;
  const result: SafePullResult = {
    changedFiles: 0,
    deletedFiles: 0,
    upToDate: false,
    conflicts: [],
    keptDeletedUpstream: [],
    lfsSkipped: [],
    lfsPointers: [],
    copies: [],
    mergedIntoOpen: [],
    kindClashes: [],
    head: ours,
  };
  if (ours === d.theirs) {
    result.upToDate = true;
    return result;
  }
  const base = await mergeBase(d, ours);
  if (base === d.theirs) {
    // Our history already contains theirs (local commits not pushed yet).
    result.upToDate = true;
    return result;
  }

  // 2–3. What the remote changed, against what is here now. (All reads
  // happen before the first write: a read that fails stops the pull with
  // nothing changed.)
  const changed = await changedBetween(d, base, d.theirs);
  const vaultPath = (p: string) => `${d.repoFolder}/${p}`;
  const open = new Map<string, OpenNote>();
  const entries: PullEntry[] = [];
  for (const c of changed) {
    const vp = vaultPath(c.path);
    const note = d.openNote(vp);
    let mine: Bytes | null;
    if (note?.dirty) {
      open.set(vp, note);
      mine = encoder.encode(note.content);
    } else {
      mine = await d.vault.read(vp);
    }
    entries.push({ path: c.path, base: await blob(d, c.base), ours: mine, theirs: await blob(d, c.theirs) });
  }
  const shortTheirs = d.theirs.slice(0, 7);
  const planned: PullAction[] = planPull(entries, d.labels);

  // A file where upstream now has a folder (or a folder where it has a
  // file) cannot take the write: check every target before writing anything,
  // so the pull never stops half way through.
  const actions: PullAction[] = [];
  for (const a of planned) {
    if (a.kind === "write" || a.kind === "conflict") {
      const vp = vaultPath(a.path);
      if (!open.has(vp) && (await kindClash(d, vp))) {
        result.kindClashes.push(vp);
        continue;
      }
    }
    actions.push(a);
  }

  // 4. Carry it out. Nothing here deletes.
  for (const a of actions) {
    const vp = vaultPath(a.path);
    const dirtyNote = open.get(vp);
    switch (a.kind) {
      case "keptDeletedUpstream":
        result.keptDeletedUpstream.push(vp);
        break;
      case "lfsSkipped":
        result.lfsSkipped.push(vp);
        break;
      case "write": {
        if (a.lfs) result.lfsPointers.push(vp);
        const text = decoder.decode(a.data);
        if (dirtyNote) {
          // Never write over unsaved edits: the merge goes into the editor.
          d.setOpenNote?.(vp, text);
          result.mergedIntoOpen.push(vp);
          break;
        }
        const before = await d.vault.read(vp);
        if (before && a.why === "merged") await d.snapshot?.(vp, decoder.decode(before));
        await d.vault.write(vp, a.data);
        d.onWritten?.(vp, text);
        result.changedFiles++;
        break;
      }
      case "binaryConflict": {
        const copy = await freeCopyPath(d, vp, `git ${shortTheirs}`);
        await d.vault.write(copy, a.theirs);
        result.copies.push(copy);
        result.changedFiles++;
        break;
      }
      case "conflict": {
        if (dirtyNote) {
          // The open note is not touched; their version waits in a copy.
          const copy = await freeCopyPath(d, vp, `git ${shortTheirs}`);
          await d.vault.write(copy, encoder.encode(a.theirs));
          result.copies.push(copy);
          result.conflicts.push({ path: vp, base: a.base, ours: a.ours, theirs: a.theirs, where: "open", copy });
          result.changedFiles++;
          break;
        }
        await d.snapshot?.(vp, a.ours);
        await d.vault.write(vp, encoder.encode(a.marked));
        d.onWritten?.(vp, a.marked);
        result.conflicts.push({ path: vp, base: a.base, ours: a.ours, theirs: a.theirs, where: "file" });
        result.changedFiles++;
        break;
      }
    }
  }

  // 5. Record the merge in the mirror. The vault already holds the result;
  // git keeps our side of anything both changed, and the next commit
  // carries what the user resolved.
  result.head = await recordMerge(d, branch, ours, base);
  return result;
}

/**
 * Move the mirror's branch to include the fetched commit: a fast-forward
 * when there are no local commits, else a merge commit whose tree keeps our
 * side wherever both sides changed a file (the vault holds the real merge).
 * Only the git mirror (lightning-fs) is checked out — never the vault.
 */
async function recordMerge(d: PullDeps, branch: string, ours: string, base: string): Promise<string> {
  const detached = branch === "HEAD";
  const ref = detached ? "HEAD" : `refs/heads/${branch}`;
  if (base === ours) {
    await d.git.writeRef({ fs: d.fs, dir: d.dir, ref, value: d.theirs, force: true });
    await d.git.checkout({ fs: d.fs, dir: d.dir, ref: detached ? d.theirs : branch, force: true });
    return d.theirs;
  }
  const message = `Merge ${d.theirs.slice(0, 7)} into ${branch}`;
  let oid: string;
  try {
    const merged = (await d.git.merge({
      fs: d.fs,
      dir: d.dir,
      ours: branch,
      theirs: d.theirs,
      author: d.author,
      message,
      mergeDriver: ({ contents }: { contents: string[] }) => ({ cleanMerge: true, mergedText: contents[1] }),
    })) as { oid?: string };
    oid = merged.oid ?? ((await d.git.resolveRef({ fs: d.fs, dir: d.dir, ref: "HEAD" })) as string);
  } catch {
    // A file deleted on one side and changed on the other: isomorphic-git
    // will not write that merge. Record it with our tree; the vault, which
    // kept every file, is what the next commit sends.
    const { commit } = (await d.git.readCommit({ fs: d.fs, dir: d.dir, oid: ours })) as { commit: { tree: string } };
    oid = (await d.git.commit({ fs: d.fs, dir: d.dir, ref, message, tree: commit.tree, parent: [ours, d.theirs], author: d.author })) as string;
  }
  await d.git.checkout({ fs: d.fs, dir: d.dir, ref: detached ? oid : branch, force: true });
  return oid;
}
