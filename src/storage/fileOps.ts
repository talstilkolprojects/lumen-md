/**
 * Safe file operations for the UI (T46): moves that never silently
 * replace a note and that keep links working, and deletes that go to the
 * trash with an Undo.
 */

import { moveToTrash, restoreFromTrash, type TrashItem } from "./trash";
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
  // Short `[[Name]]` links resolve against the vault as it was.
  const vault = (await listWorkspace()).map((f) => f.path).filter((p) => /\.(md|markdown)$/i.test(p));
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

/** Delete = move to the trash. Returns the trash entries for Undo. */
export async function trashPaths(paths: string[], kinds: Record<string, "file" | "directory"> = {}): Promise<TrashItem[]> {
  const items = await moveToTrash(paths, kinds);
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  return items;
}

/** Undo a delete: restore every given entry. Returns where they went. */
export async function undoTrash(items: TrashItem[]): Promise<string[]> {
  const out: string[] = [];
  for (const i of items) out.push(await restoreFromTrash(i.id));
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  return out;
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

/** A move that would put a PDF on its own highlights note's path, or that note on the PDF's. Nothing moved. */
export class CompanionPathError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(
      /\.pdf$/i.test(from)
        ? `"${to}" is the highlights note of "${from}": the PDF can't take its note's name`
        : `"${from}" is the highlights note of "${to}": the note can't take its PDF's name`,
    );
    this.name = "CompanionPathError";
  }
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
  // Before anything moves (review #272, step 2.19): a PDF renamed onto its
  // own highlights note (`paper.pdf` → `paper.pdf.md`) would put the note in
  // the trash and the PDF's bytes at `paper.pdf.md.md`; a highlights note
  // renamed onto its PDF's name would replace the PDF.
  if (!opts.folder && from !== to) {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const ownNote = companionNoteOf(from);
    const targetsNote = companionNoteOf(to);
    if ((ownNote && same(to, ownNote)) || (targetsNote && same(targetsNote, from))) throw new CompanionPathError(from, to);
  }
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
