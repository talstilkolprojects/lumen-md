/**
 * Trash (MASTER_PLAN v3, T46): deleting a note or folder moves it to
 * `.trash/` in the vault instead of destroying it. Restorable from the
 * Trash panel or with "Undo" right after; emptied after 30 days.
 *
 * Layout: `.trash/<id>/<original base name>` plus `.trash/index.json`
 * (`{ id, originalPath, trashedAt, kind }[]`). Dot folders are hidden from
 * the file tree, search and the index.
 */

import {
  basename,
  deleteWorkspaceFile,
  readWorkspaceFile,
  renameWorkspaceFile,
  uniqueWorkspaceName,
  workspaceHasEntry,
  writeWorkspaceFile,
} from "./workspace";
import { VaultNotFoundError } from "./vault/types";

export const TRASH_DIR = ".trash";
const INDEX = `${TRASH_DIR}/index.json`;
export const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrashItem {
  id: string;
  originalPath: string;
  trashedAt: number;
  kind: "file" | "directory";
}

async function readIndex(): Promise<TrashItem[]> {
  try {
    const parsed = JSON.parse(await readWorkspaceFile(INDEX)) as unknown;
    return Array.isArray(parsed) ? (parsed as TrashItem[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(items: TrashItem[]): Promise<void> {
  await writeWorkspaceFile(INDEX, JSON.stringify(items, null, 1));
}

/** Where `path` (the trashed entry itself or something inside it) sits in the trash now, or null. */
export function trashedPathOf(item: TrashItem, path: string): string | null {
  const at = `${TRASH_DIR}/${item.id}/${basename(item.originalPath)}`;
  if (path === item.originalPath) return at;
  if (path.startsWith(item.originalPath + "/")) return at + path.slice(item.originalPath.length);
  return null;
}

/** Items in the trash, newest first. */
/**
 * The index as stored, or null when it cannot be read (storage failing, a
 * damaged file). Unlike listTrash, an unreadable index is not an empty trash;
 * a trash that was never written has no index file and is empty.
 */
export async function readTrashIndex(): Promise<TrashItem[] | null> {
  let text: string;
  try {
    text = await readWorkspaceFile(INDEX);
  } catch (e) {
    return e instanceof VaultNotFoundError ? [] : null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as TrashItem[]) : null;
  } catch {
    return null;
  }
}

export async function listTrash(): Promise<TrashItem[]> {
  return (await readIndex()).sort((a, b) => b.trashedAt - a.trashedAt);
}

/*
 * Every change to the index is a read-modify-write (delete, restore, empty).
 * They run one at a time, or a restore racing a delete (Ctrl+Z during a slow
 * folder move, the Trash panel during a delete) writes the index back
 * without the other's entry, leaving trashed data no panel can find.
 */
let indexQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(fn, fn);
  indexQueue = run.catch(() => undefined);
  return run;
}

let lastTrashed: TrashItem[] = [];
/** What the last `moveToTrash` call trashed (for "Undo"). */
export function lastTrashedItems(): TrashItem[] {
  return lastTrashed;
}

/**
 * Move files / folders to the trash. Returns the trash entries.
 *
 * `afterMove` runs inside the same turn of the queue, once the entries are
 * moved and indexed: no restore, empty or other delete can touch them
 * before it finishes (the file tree writes edits typed during the delete
 * into the trashed copies there).
 */
export function moveToTrash(
  paths: string[],
  kinds: Record<string, "file" | "directory"> = {},
  now = Date.now(),
  afterMove?: (items: TrashItem[]) => Promise<void>,
): Promise<TrashItem[]> {
  return serialized(async () => {
    const items = await moveToTrashNow(paths, kinds, now);
    if (afterMove && items.length) await afterMove(items);
    return items;
  });
}

/** A delete that moved some paths to the trash before another failed. `items` are the ones that moved. */
export class PartialTrashError extends Error {
  constructor(readonly items: TrashItem[], readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PartialTrashError";
  }
}

async function moveToTrashNow(paths: string[], kinds: Record<string, "file" | "directory">, now: number): Promise<TrashItem[]> {
  const items = await readIndex();
  const added: TrashItem[] = [];
  // A folder and something inside it can both be selected: trashing the
  // folder takes the descendant along, so only the outermost paths move.
  const unique = [...new Set(paths)];
  const roots = unique.filter((p) => !unique.some((q) => q !== p && p.startsWith(q + "/")));
  try {
    for (const path of roots) {
      const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await renameWorkspaceFile(path, `${TRASH_DIR}/${id}/${basename(path)}`);
      const item: TrashItem = { id, originalPath: path, trashedAt: now, kind: kinds[path] ?? (/\.[^/]+$/.test(path) ? "file" : "directory") };
      items.push(item);
      added.push(item);
    }
  } catch (e) {
    // The caller still gets what did move (to keep it undoable).
    throw added.length ? new PartialTrashError([...added], e) : e;
  } finally {
    // Record whatever did move even when a later move fails, so nothing
    // sits in `.trash/` without an entry the Trash panel can restore.
    if (added.length) {
      await writeIndex(items);
      lastTrashed = added;
    }
  }
  return added;
}

/**
 * Put a trashed item back at its original path, or next to it under a free
 * name when something new took that path. Returns where it went.
 */
export function restoreFromTrash(id: string): Promise<string> {
  return serialized(async () => {
    const where = await restoreNow(id);
    if (where === null) throw new Error("Not in the trash");
    return where;
  });
}

/** Like `restoreFromTrash`, but null when the item is no longer in the trash (restored or purged meanwhile). */
export function restoreFromTrashIfPresent(id: string): Promise<string | null> {
  return serialized(() => restoreNow(id));
}

async function restoreNow(id: string): Promise<string | null> {
  const items = await readIndex();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  let target = item.originalPath;
  if (await workspaceHasEntry(target)) {
    if (item.kind === "file") target = await uniqueWorkspaceName(target);
    else {
      let n = 2;
      while (await workspaceHasEntry(`${item.originalPath} ${n}`)) n++;
      target = `${item.originalPath} ${n}`;
    }
  }
  await renameWorkspaceFile(`${TRASH_DIR}/${id}/${basename(item.originalPath)}`, target);
  await deleteWorkspaceFile(`${TRASH_DIR}/${id}`).catch(() => undefined);
  await writeIndex(items.filter((i) => i.id !== id));
  lastTrashed = lastTrashed.filter((i) => i.id !== id);
  return target;
}

/** Delete for good: one item, or everything older than `olderThanMs`. */
export function emptyTrash(opts: { id?: string; olderThanMs?: number } = {}, now = Date.now()): Promise<number> {
  return serialized(async () => {
    const items = await readIndex();
    const doomed = items.filter((i) => (opts.id ? i.id === opts.id : now - i.trashedAt >= (opts.olderThanMs ?? 0)));
    for (const i of doomed) await deleteWorkspaceFile(`${TRASH_DIR}/${i.id}`).catch(() => undefined);
    await writeIndex(items.filter((i) => !doomed.includes(i)));
    return doomed.length;
  });
}

/** Startup housekeeping: drop items older than 30 days. */
export async function purgeExpiredTrash(now = Date.now()): Promise<number> {
  return emptyTrash({ olderThanMs: TRASH_KEEP_MS }, now);
}
