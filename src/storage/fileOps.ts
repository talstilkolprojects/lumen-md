/**
 * Safe file operations for the UI (T46): moves that never silently
 * replace a note and that keep links working, and deletes that go to the
 * trash with an Undo.
 */

import { moveToTrash, PartialTrashError, readTrashIndex, restoreFromTrash, restoreFromTrashIfPresent, type TrashItem } from "./trash";
import { rewriteLinks, updateLinksAfterMove } from "./linkRewrite";
import {
  basename,
  dirname,
  joinPath,
  listWorkspace,
  readWorkspaceBlob,
  renameWorkspaceFile,
  uniqueWorkspaceName,
  WorkspaceConflictError,
  workspaceHasEntry,
  writeWorkspaceBlob,
} from "./workspace";

export interface MoveResult {
  /** Where the entry is now. */
  path: string;
  /** Notes whose links were rewritten. */
  linksUpdated: string[];
  /** The entry that was at the target and went to the trash (overwrite). */
  replaced?: TrashItem;
  /** The move happened, but rewriting links failed part way (e.g. quota). */
  linksError?: Error;
  /**
   * Apply the same link rewrite to a note's text held in memory (an open
   * tab), given where that note was before the move.
   */
  rewrite: (content: string, notePrevPath: string) => string;
}

/** Where `path` is after `from` moved to `to` (folders take their contents along), or null. */
export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return null;
}

/** The entry is at its new path; links not rewritten yet. */
interface Moved {
  replaced?: TrashItem;
  /** Note paths before the move (short `[[Name]]` links resolve against them). */
  vault: string[];
}

/** Rename `from` → `to` (asking before replacing), without touching links. Null: cancelled. */
async function moveEntry(from: string, to: string, confirmReplace?: (path: string) => Promise<boolean>): Promise<Moved | null> {
  let replaced: TrashItem | undefined;
  // Short `[[Name]]` links — and `![[image.png]]` embeds — resolve against
  // the vault as it was.
  const vault = (await listWorkspace()).map((f) => f.path);
  if (await workspaceHasEntry(to)) {
    if (!confirmReplace || !(await confirmReplace(to))) return null;
    [replaced] = await moveToTrash([to]);
  }
  try {
    await renameWorkspaceFile(from, to);
  } catch (e) {
    if (replaced) await restoreFromTrash(replaced.id).catch(() => undefined);
    if (e instanceof WorkspaceConflictError) return null;
    throw e;
  }
  return { replaced, vault };
}

/** Rewrite the links after a move that `moveEntry` made. */
async function relink(from: string, to: string, folder: boolean | undefined, moved: Moved): Promise<MoveResult> {
  // The entry has moved: report that even when a link rewrite fails, so
  // the caller still retargets the open note instead of autosaving it back
  // to the old path.
  let linksUpdated: string[] = [];
  let linksError: Error | undefined;
  try {
    linksUpdated = await updateLinksAfterMove(from, to, { folder, vault: moved.vault });
  } catch (e) {
    linksError = e instanceof Error ? e : new Error(String(e));
  }
  // Per-note reading options follow the note (plan W3.5) — only once someone has set any.
  try {
    if (localStorage.getItem("lumen-reading") !== null) (await import("../reading/settings")).moveNoteReading(from, to);
  } catch {
    /* no storage: nothing to move */
  }
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  const vault = moved.vault;
  const rewrite = (content: string, notePrevPath: string) =>
    rewriteLinks(content, movedPath(notePrevPath, from, to) ?? notePrevPath, from, to, { folder, notePrevPath, vault });
  return { path: to, linksUpdated, replaced: moved.replaced, linksError, rewrite };
}

/**
 * Move `from` to `to`. When something is already at `to`, asks
 * `confirmReplace(to)`; on yes the existing entry goes to the trash (so even
 * an overwrite is undoable), on no the move is cancelled (returns null).
 */
export async function safeMove(
  from: string,
  to: string,
  opts: { folder?: boolean; confirmReplace?: (path: string) => Promise<boolean> } = {},
): Promise<MoveResult | null> {
  if (from === to) return { path: to, linksUpdated: [], rewrite: (c) => c };
  const moved = await moveEntry(from, to, opts.confirmReplace);
  return moved ? relink(from, to, opts.folder, moved) : null;
}

/**
 * Copy a file byte for byte to `<name> copy.<ext>` (a free name) next to it.
 * Through blobs, not text: a PDF or an image read as text and written back
 * would come out corrupted. Returns the copy's path.
 */
export async function duplicateFile(path: string): Promise<string> {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const target = await uniqueWorkspaceName(joinPath(dirname(path), `${stem} copy${ext}`));
  await writeWorkspaceBlob(target, await readWorkspaceBlob(path));
  return target;
}

/**
 * The last deletes, oldest first, for Ctrl+Z outside the editor (plan 3.1).
 * One entry per delete action (a bulk delete is one entry). Runtime only:
 * after a reload the Trash panel still has everything.
 */
export const TRASH_UNDO_LIMIT = 20;
const undoStack: TrashItem[][] = [];

/** How many deletes Ctrl+Z can still undo (entries restored elsewhere are counted until the next undo skips them). */
export function trashUndoDepth(): number {
  return undoStack.length;
}

/** Test hook. */
export function __resetTrashUndo(): void {
  undoStack.length = 0;
}

/** These items are back (or being brought back): no stack entry may restore them again. */
function forgetUndo(items: TrashItem[]): void {
  const ids = new Set(items.map((i) => i.id));
  for (let n = undoStack.length - 1; n >= 0; n--) {
    const rest = undoStack[n].filter((i) => !ids.has(i.id));
    if (rest.length) undoStack[n] = rest;
    else undoStack.splice(n, 1);
  }
}

// Undos run one at a time, so each press pops (and restores) its own entry
// in order. The trash index itself is guarded in trash.ts, where deletes,
// restores and the Trash panel all go through one queue.
let restoring: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = restoring.then(fn, fn);
  restoring = run.catch(() => undefined);
  return run;
}

/** Restore the given entries that are still in the trash (the Trash panel may have restored or purged some). */
async function restoreItems(items: TrashItem[]): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const i of items) {
      const where = await restoreFromTrashIfPresent(i.id);
      if (where !== null) out.push(where);
    }
  } finally {
    window.dispatchEvent(new Event("lumen-workspace-changed"));
  }
  return out;
}

/**
 * Delete = move to the trash. Returns the trash entries for Undo (and
 * remembers them for Ctrl+Z). `afterMove` runs inside the trash queue right
 * after the move (see `moveToTrash`). The entries become undoable, and the
 * change is announced, only once it is done.
 */
export async function trashPaths(
  paths: string[],
  kinds: Record<string, "file" | "directory"> = {},
  afterMove?: (items: TrashItem[]) => Promise<void>,
): Promise<TrashItem[]> {
  let moved: TrashItem[] = [];
  try {
    await moveToTrash(paths, kinds, undefined, async (items) => {
      moved = items;
      if (afterMove) await afterMove(items);
    });
    return moved;
  } catch (e) {
    // Part of a bulk delete moved before a later path failed: that part is undoable too.
    if (e instanceof PartialTrashError && !moved.length) moved = e.items;
    throw e;
  } finally {
    // Even when `afterMove` failed, what moved is in the trash: keep it undoable.
    if (moved.length) {
      undoStack.push(moved);
      if (undoStack.length > TRASH_UNDO_LIMIT) undoStack.splice(0, undoStack.length - TRASH_UNDO_LIMIT);
    }
    window.dispatchEvent(new Event("lumen-workspace-changed"));
  }
}

/** Undo a delete: restore every given entry still in the trash. Returns where they went. */
export async function undoTrash(items: TrashItem[]): Promise<string[]> {
  forgetUndo(items);
  return oneAtATime(async () => {
    try {
      return await restoreItems(items);
    } catch (e) {
      // The toast is gone after its click: what is still in the trash goes
      // back on the stack, so Ctrl+Z can retry it (review: #218).
      await requeueLeftInTrash(items);
      throw e;
    }
  });
}

/** After a failed restore: put the given entries still in the trash back on top of the Ctrl+Z stack. */
async function requeueLeftInTrash(items: TrashItem[]): Promise<void> {
  // An index that cannot be read (the outage that failed the restore) says
  // nothing about what is left: keep every entry, and a restore of one that is
  // gone after all is a no-op (W1.32, Codex on #218).
  const index = await readTrashIndex();
  const left = index === null ? null : new Set(index.map((i) => i.id));
  const keep = left === null ? items : items.filter((i) => left.has(i.id));
  if (!keep.length) return;
  undoStack.push(keep);
  if (undoStack.length > TRASH_UNDO_LIMIT) undoStack.splice(0, undoStack.length - TRASH_UNDO_LIMIT);
}

/**
 * Ctrl+Z outside the editor: restore the most recent delete that is still
 * in the trash and drop it from the stack, so the next call restores the one
 * before. Resolves to where the entries went, or null when there is nothing
 * left to undo. When a restore fails, what is still in the trash stays on
 * the stack for another try.
 */
export function undoLastTrash(): Promise<string[] | null> {
  return oneAtATime(async () => {
    while (undoStack.length) {
      const entry = undoStack.pop()!;
      try {
        const restored = await restoreItems(entry);
        // Nothing of it was left in the trash: undo the delete before it.
        if (restored.length) return restored;
      } catch (e) {
        await requeueLeftInTrash(entry);
        throw e;
      }
    }
    return null;
  });
}

/**
 * The file name a rename ends up with. A name typed without an extension
 * keeps the file's own: a note gets `.md`, but `paper.pdf` renamed to
 * `draft` stays a PDF (`draft.pdf`), not `draft.md` (plan 4.14).
 */
export function renamedFileName(oldPath: string, typed: string): string {
  if (/\.[^./]+$/.test(typed)) return typed;
  const ext = oldPath.match(/\.[^./]+$/)?.[0] ?? "";
  return typed + (ext && !/^\.(md|markdown)$/i.test(ext) ? ext : ".md");
}

/** The highlights note that belongs to a PDF (`<file>.pdf.md`, plan 4.14), or null for other files. */
export function companionNoteOf(path: string): string | null {
  return /\.pdf$/i.test(path) ? `${path}.md` : null;
}

/**
 * The entries of a multi-file move, minus each highlights note whose PDF is
 * in the move too: the PDF's `safeMoveWithCompanion` moves the pair as one
 * unit, both destinations checked first.
 */
export function withoutCompanions(paths: readonly string[]): string[] {
  const set = new Set(paths);
  return paths.filter((p) => !(/\.pdf\.md$/i.test(p) && set.has(p.slice(0, -3))));
}

/**
 * `safeMove` for a file that has a companion note (a PDF and its
 * `<file>.pdf.md`): both move together. Both destinations are checked first,
 * so a declined replace leaves both files where they were; if the note's
 * move then fails, the file is moved back (and anything it replaced comes
 * back from the trash). Without a companion — or when `alsoMoving` already
 * includes it — this is `safeMove`.
 */
export async function safeMoveWithCompanion(
  from: string,
  to: string,
  opts: { folder?: boolean; confirmReplace?: (path: string) => Promise<boolean>; alsoMoving?: ReadonlySet<string> } = {},
): Promise<{ main: MoveResult; companion: MoveResult | null } | null> {
  const note = opts.folder ? null : companionNoteOf(from);
  if (!note || from === to || opts.alsoMoving?.has(note) || !(await workspaceHasEntry(note))) {
    const main = await safeMove(from, to, opts);
    return main ? { main, companion: null } : null;
  }
  const noteTo = `${to}.md`;
  // Ask about both replacements before anything moves.
  const confirmed = new Set<string>();
  for (const target of [to, noteTo]) {
    if (!(await workspaceHasEntry(target))) continue;
    if (!opts.confirmReplace || !(await opts.confirmReplace(target))) return null;
    confirmed.add(target);
  }
  const already = (p: string) => Promise.resolve(confirmed.has(p));
  // Both renames first; links are rewritten only once both are done, so a
  // failed second move never leaves links pointing at the wrong file.
  const pdfMoved = await moveEntry(from, to, already);
  if (!pdfMoved) return null;
  let noteMoved: Moved | null = null;
  let failure: unknown = null;
  try {
    noteMoved = await moveEntry(note, noteTo, already);
  } catch (e) {
    failure = e;
  }
  if (!noteMoved) {
    // Put the file back where it was, next to its note; nothing was relinked.
    await renameWorkspaceFile(to, from);
    if (pdfMoved.replaced) await restoreFromTrash(pdfMoved.replaced.id).catch(() => undefined);
    if (failure) throw failure;
    return null;
  }
  const main = await relink(from, to, false, pdfMoved);
  const companion = await relink(note, noteTo, false, noteMoved);
  return { main, companion };
}
