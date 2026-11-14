/**
 * The vault move's errors and its byte-for-byte check (split out of
 * location.ts, plan W4.11; it re-exports the error classes and MoveReport).
 */
import { log } from "../../lib/logger";
import { notifyWorkspaceChanged } from "../workspaceEvents";
import { vaultEncryptionReady } from "./index";
import type { VaultBackend } from "./types";

/** Files at the target that already exist with different content: nothing was written. */
export class VaultMoveConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`${paths.length} file(s) already exist at the target with different content: ${paths.slice(0, 3).join(", ")}`);
    this.name = "VaultMoveConflictError";
  }
}

/**
 * An encrypted vault (plan 11.4) is not moved: the move copies what the
 * vault layer reads, which is the decrypted notes. Turn encryption off,
 * move, and turn it on again in the new place.
 */
export class VaultEncryptedMoveError extends Error {
  constructor() {
    super("An encrypted vault can't be moved. Turn encryption off first, move it, then turn it on again.");
    this.name = "VaultEncryptedMoveError";
  }
}

export async function refuseEncryptedMove(): Promise<void> {
  const state = await vaultEncryptionReady();
  if (state === "locked" || state === "unlocked") throw new VaultEncryptedMoveError();
}

/** The browser did not grant read-write access to the folder. */
export class VaultPermissionError extends Error {
  constructor(readonly folder: string) {
    super(`No permission to edit “${folder}”`);
    this.name = "VaultPermissionError";
  }
}

export interface MoveReport {
  files: number;
  bytes: number;
  /** Files already identical at the target (a resume, or a merge into an existing folder). */
  unchanged: number;
  /**
   * Moving back: copies an earlier move left at the target whose notes were
   * deleted since, put in the trash (restorable) instead of reappearing.
   */
  trashed: number;
  /**
   * Notes saved in the source between the final check and the switch (an
   * autosave in that moment): their newer text, written to the new vault
   * after the switch — next to the note as “name (conflict copy).md” when the
   * note is there, at its own path when it is new. Empty almost always (2.9).
   */
  conflictCopies: string[];
}

/** Every file and every folder path of `b`, dot entries (the trash) included (2.79). */
export async function allEntries(b: VaultBackend, dir = "", out: { files: string[]; dirs: string[] } = { files: [], dirs: [] }): Promise<{ files: string[]; dirs: string[] }> {
  for (const e of await b.list(dir)) {
    if (e.kind === "directory") {
      out.dirs.push(e.path);
      await allEntries(b, e.path, out);
    } else out.files.push(e.path);
  }
  return out;
}

/** "a/b/c.md" → ["a", "a/b"]. */
export function parentsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** A free path next to `path` for a conflict copy: “a (conflict copy).md”, then “a (conflict copy 2).md”, … */
export async function conflictCopyPath(b: VaultBackend, path: string): Promise<string> {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  for (let n = 1; ; n++) {
    const candidate = `${dir}${stem} (conflict copy${n > 1 ? ` ${n}` : ""})${ext}`;
    if (!(await b.stat(candidate))) return candidate;
  }
}

export async function bytes(b: VaultBackend, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await b.read(path)).arrayBuffer());
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function targetBytes(b: VaultBackend, path: string): Promise<Uint8Array | null> {
  const st = await b.stat(path);
  if (!st) return null;
  if (st.kind !== "file") throw new VaultMoveConflictError([path]);
  return bytes(b, path);
}

/**
 * The post-switch check of a move (2.9): source files written after the
 * final check (their hash is not the one verified at the target) go to
 * `target` — a conflict copy next to the note, or the note's own path when
 * the target has nothing there. Never throws: the switch has already happened.
 */
export async function saveLateWrites(source: VaultBackend, target: VaultBackend, checked: Record<string, string>): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const path of (await allEntries(source)).files.sort()) {
      try {
        const data = await bytes(source, path);
        if (checked[path] === (await sha256(data))) continue;
        const there = await targetBytes(target, path).catch(() => "blocked" as const);
        if (there !== "blocked" && there && same(there, data)) continue;
        const dest = there === null ? path : await conflictCopyPath(target, path);
        await target.write(dest, data);
        out.push(dest);
      } catch (err) {
        log.warn(`the post-switch check could not save “${path}”; it is still in the previous vault`, err);
      }
    }
  } catch (err) {
    log.warn("the post-switch check could not list the previous vault", err);
  }
  if (out.length) notifyWorkspaceChanged({ kind: "structure", paths: out });
  return out;
}

/**
 * Step 1 of a move (moved out of location.ts): nothing is written while any
 * target file differs and is not ours (`known`), and no file sits where the
 * source has a folder. Returns the conflicts and what each target path holds
 * now (its hash), so a change during the copy stops the move.
 */
export async function preflight(
  source: VaultBackend,
  target: VaultBackend,
  files: string[],
  dirs: string[],
  known: (path: string, hash: string) => boolean,
): Promise<{ conflicts: string[]; before: Map<string, string | null> }> {
  const conflicts: string[] = [];
  const before = new Map<string, string | null>();
  // A file at the target where the source has a folder — the folder
  // itself, or a parent of any source path — would stop the copy halfway:
  // it is a conflict now, before anything is written (2.79).
  const folders = [...new Set([...dirs, ...files.flatMap(parentsOf)])].sort();
  const blocked = new Set<string>();
  for (const dir of folders) {
    if (parentsOf(dir).some((p) => blocked.has(p))) continue;
    const st = await target.stat(dir);
    if (st && st.kind !== "directory") {
      blocked.add(dir);
      conflicts.push(dir);
    }
  }
  for (const path of files) {
    if (parentsOf(path).some((p) => blocked.has(p))) continue;
    const there = await targetBytes(target, path).catch((e) => {
      if (e instanceof VaultMoveConflictError) return "conflict" as const;
      throw e;
    });
    if (there === "conflict") {
      conflicts.push(path);
      continue;
    }
    const hash = there ? await sha256(there) : null;
    before.set(path, hash);
    if (there && hash && !same(there, await bytes(source, path)) && !known(path, hash)) conflicts.push(path);
  }
  return { conflicts, before };
}

/**
 * After a move back (moved out of location.ts): copies this vault left at
 * `target` earlier and that were deleted since (not in `copied`) would come
 * back to life. They go to the trash of the vault that is now active —
 * restorable, not deleted. Returns how many.
 */
export async function trashLeftovers(target: VaultBackend, leftBehind: Record<string, string>, copied: Record<string, string>): Promise<number> {
  const stale: string[] = [];
  for (const [path, hash] of Object.entries(leftBehind)) {
    if (copied[path]) continue;
    const there = await targetBytes(target, path).catch(() => null);
    if (there && (await sha256(there)) === hash) stale.push(path);
  }
  let trashed = 0;
  if (stale.length) {
    const { moveToTrash, readTrashIndex, trashedPathOf } = await import("../trash");
    // A note deleted into the trash of the vault it came from is already in
    // the trash copied here: a leftover with the same bytes is a duplicate
    // of that entry, so it goes, instead of becoming a second entry (W1.32, Codex on #235).
    const index = (await readTrashIndex()) ?? [];
    const toTrash: string[] = [];
    for (const path of stale) {
      const leftover = await targetBytes(target, path).catch(() => null);
      let duplicate = false;
      for (const item of index) {
        const at = trashedPathOf(item, path);
        const kept = at ? await targetBytes(target, at).catch(() => null) : null;
        if (leftover && kept && same(leftover, kept)) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) {
        await target.remove(path);
        trashed++;
      } else toTrash.push(path);
    }
    if (toTrash.length) trashed += (await moveToTrash(toTrash, Object.fromEntries(toTrash.map((p) => [p, "file" as const])))).length;
    notifyWorkspaceChanged({ kind: "structure" });
  }
  return trashed;
}
