/**
 * A vault backend over a `FileSystemDirectoryHandle` — the one place that
 * walks file-system handles (getDirectoryHandle / getFileHandle /
 * createWritable / removeEntry).
 *
 * The OPFS backend (./opfs.ts) is this with the OPFS root; a folder the
 * user picked with `showDirectoryPicker` is the same API, so the Chromium
 * real-folder vault (plan 4.3) and the folder export reuse it unchanged.
 *
 * The File System Access API has no rename for files in every engine
 * (`FileSystemHandle.move` is not universal), so a rename copies and then
 * deletes, removing a half-written target when the copy fails.
 */

import { checkRename, compareVaultEntries, VaultEmitter, vaultSegments } from "./shared";
import {
  VaultError,
  VaultNotFoundError,
  WorkspaceConflictError,
  type VaultBackend,
  type VaultData,
  type VaultEntry,
  type VaultEvent,
  type VaultStat,
} from "./types";

export interface DirectoryHandleBackendOptions {
  id: string;
  /**
   * The root folder. Called for every operation (not cached), so a root
   * that changes — a fresh OPFS in tests, a re-picked folder — is used at once.
   */
  root: () => Promise<FileSystemDirectoryHandle>;
  /** Defaults to "always". */
  available?: () => boolean;
  /**
   * Writes for engines whose file handles have no `createWritable` on the
   * main thread (OPFS in Safari before 26 / Playwright WebKit). Gets the
   * path segments relative to `root`.
   */
  writeFallback?: (segments: string[], data: VaultData) => Promise<void>;
  /** Is a `writeFallback` save still running (its temporary files are not leftovers yet)? */
  writesPending?: () => boolean;
}

/** Names an interrupted atomic save leaves (./atomic.ts, written by the OPFS worker). */
const isSaveLeftover = (name: string) => name.startsWith(".lumen-old~") || name.startsWith(".lumen-tmp~") || /^\.lumen-(tmp|old|jnl)-[0-9a-f]{16}$/.test(name);

type Found =
  | { kind: "file"; handle: FileSystemFileHandle }
  | { kind: "directory"; handle: FileSystemDirectoryHandle };

/** OPFS signals "not there" and "not that kind" with these DOMException names. */
function isMissing(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "NotFoundError" || name === "TypeMismatchError";
}

export function createDirectoryHandleBackend(o: DirectoryHandleBackendOptions): VaultBackend {
  const events = new VaultEmitter();
  const emit = (e: Omit<VaultEvent, "origin">) => events.emit({ ...e, origin: "self" });

  async function dirAt(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let cur = await o.root();
    for (const part of parts) cur = await cur.getDirectoryHandle(part, { create });
    return cur;
  }

  /** What is at `parts`, or null. Errors other than "not there" propagate. */
  async function lookup(parts: string[]): Promise<Found | null> {
    if (!parts.length) return { kind: "directory", handle: await o.root() };
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await dirAt(parts.slice(0, -1), false);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    const name = parts[parts.length - 1];
    try {
      return { kind: "file", handle: await parent.getFileHandle(name) };
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    try {
      return { kind: "directory", handle: await parent.getDirectoryHandle(name) };
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    return null;
  }

  async function fileAt(parts: string[], path: string): Promise<FileSystemFileHandle> {
    if (!parts.length) throw new VaultNotFoundError(path);
    try {
      const dir = await dirAt(parts.slice(0, -1), false);
      return await dir.getFileHandle(parts[parts.length - 1]);
    } catch (e) {
      if (isMissing(e)) throw new VaultNotFoundError(path);
      throw e;
    }
  }

  /** fileAt, finishing an interrupted save of the file first when it is missing. */
  async function fileRecovered(path: string): Promise<FileSystemFileHandle> {
    const parts = vaultSegments(path);
    try {
      return await fileAt(parts, path);
    } catch (e) {
      if (!(e instanceof VaultNotFoundError) || !parts.length || !(await recoverIn(parts.slice(0, -1)))) throw e;
      return await fileAt(parts, path);
    }
  }

  async function writeAt(parts: string[], data: VaultData, path: string): Promise<void> {
    if (!parts.length) throw new VaultError("EKIND", path, "Cannot write to the vault root");
    let handle: FileSystemFileHandle;
    try {
      const dir = await dirAt(parts.slice(0, -1), true);
      handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    } catch (e) {
      if (isMissing(e)) throw new VaultError("EKIND", path, `Cannot write "${path}": a file or folder of that name is in the way`);
      throw e;
    }
    if (typeof (handle as { createWritable?: unknown }).createWritable !== "function") {
      if (!o.writeFallback) throw new Error("This browser cannot write files here.");
      return o.writeFallback(parts, data);
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(data as FileSystemWriteChunkType);
    } catch (e) {
      // Drop the half-written swap file instead of leaving the stream open.
      await (writable as { abort?: () => Promise<void> }).abort?.().catch(() => undefined);
      throw e;
    }
    await writable.close();
  }

  async function removeAt(parts: string[], path: string): Promise<void> {
    if (!parts.length) throw new VaultError("EINVAL", path, "Cannot delete the workspace root");
    try {
      const parent = await dirAt(parts.slice(0, -1), false);
      await parent.removeEntry(parts[parts.length - 1], { recursive: true });
    } catch (e) {
      if (isMissing(e)) throw new VaultNotFoundError(path);
      throw e;
    }
  }

  async function copyTree(dir: FileSystemDirectoryHandle, to: string[]): Promise<void> {
    await dirAt(to, true);
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") await copyTree(handle as FileSystemDirectoryHandle, [...to, name]);
      else await writeAt([...to, name], await (handle as FileSystemFileHandle).getFile(), [...to, name].join("/"));
    }
  }

  /** Do two handles name the same entry? (Only real folders can alias; engines without isSameEntry say no.) */
  async function sameEntry(a: FileSystemHandle, b: FileSystemHandle): Promise<boolean> {
    const f = (a as { isSameEntry?: (other: FileSystemHandle) => Promise<boolean> }).isSameEntry;
    return typeof f === "function" ? await f.call(a, b) : false;
  }

  /** The existing folders strictly above `parts` (root excluded), outermost first; stops at the first missing one. */
  async function existingAncestors(parts: string[]): Promise<FileSystemDirectoryHandle[]> {
    const out: FileSystemDirectoryHandle[] = [];
    let cur = await o.root();
    for (const part of parts.slice(0, -1)) {
      try {
        cur = await cur.getDirectoryHandle(part);
      } catch (e) {
        if (isMissing(e)) break;
        throw e;
      }
      out.push(cur);
    }
    return out;
  }

  /** Copy `source` to `dst` (replacing `target`, when set), then delete the source. No event. */
  async function move(src: string[], dstParts: string[], source: Found, target: Found | null): Promise<void> {
    const dst = dstParts.join("/");
    // Replacing: a folder at the target (or a folder replacing a file)
    // goes first, so nothing of the old entry merges into the new one.
    // (A file replacing a file is written in place: an aborted write
    // leaves the old content.)
    let cleared = false;
    if (target && (target.kind === "directory" || source.kind === "directory")) {
      await removeAt(dstParts, dst);
      cleared = true;
    }
    try {
      if (source.kind === "directory") await copyTree(source.handle, dstParts);
      else await writeAt(dstParts, await source.handle.getFile(), dst);
    } catch (e) {
      // A copy that failed half way (quota, write error) must not leave a
      // partial tree at the target: it would block a retry, or sit at the
      // name of an original that a replace moved to the trash. The source
      // is untouched either way.
      if (!target || cleared) await removeAt(dstParts, dst).catch(() => undefined);
      throw e;
    }
    await removeAt(src, src.join("/"));
  }

  /**
   * Finish or undo a save the OPFS worker was stopped in the middle of
   * (./atomic.ts) in folder `dirParts`. The recovery code loads only when
   * such leftovers are there. Returns whether anything was done.
   */
  // Folders found without leftovers in this session. Leftovers come from a
  // run that was stopped (a failed save removes its own), so a clean folder
  // stays clean and a missing file costs one scan of its folder at most.
  const clean = new Set<string>();
  async function recoverIn(dirParts: string[]): Promise<boolean> {
    const key = dirParts.join("/");
    if (clean.has(key) || o.writesPending?.()) return false;
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await dirAt(dirParts, false);
    } catch {
      return false;
    }
    const names: string[] = [];
    for await (const [name] of dir.entries()) names.push(name);
    if (!names.some(isSaveLeftover)) {
      clean.add(key);
      return false;
    }
    const { recoverHandleDir } = await import("./atomic");
    await recoverHandleDir<Found>(
      {
        lookup,
        move,
        removeAt,
        writeAt,
        segments: vaultSegments,
        fileSize: async (f) => (f.kind === "file" ? (await f.handle.getFile()).size : null),
        fileBytes: async (f) => {
          if (f.kind !== "file") throw new Error("a folder, not a file");
          return new Uint8Array(await (await f.handle.getFile()).arrayBuffer());
        },
      },
      key,
      names,
    );
    clean.add(key);
    return true;
  }

  return {
    id: o.id,

    available: () => (o.available ? o.available() : true),

    async list(dir) {
      const parts = vaultSegments(dir);
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await dirAt(parts, false);
      } catch (e) {
        if (isMissing(e)) throw new VaultNotFoundError(dir);
        throw e;
      }
      const out: VaultEntry[] = [];
      let leftovers = false;
      for await (const [name, child] of handle.entries()) {
        if (isSaveLeftover(name)) leftovers = true;
        const path = [...parts, name].join("/");
        if (child.kind === "directory") {
          out.push({ name, path, kind: "directory" });
          continue;
        }
        try {
          const file = await (child as FileSystemFileHandle).getFile();
          out.push({ name, path, kind: "file", size: file.size, mtime: file.lastModified });
        } catch {
          out.push({ name, path, kind: "file" });
        }
      }
      // An interrupted save: finish or undo it, then list again.
      if (leftovers && (await recoverIn(parts))) return this.list(dir);
      if (!leftovers) clean.add(parts.join("/"));
      return out.sort(compareVaultEntries);
    },

    async stat(path): Promise<VaultStat | null> {
      const parts = vaultSegments(path);
      let found = await lookup(parts);
      if (!found && parts.length && (await recoverIn(parts.slice(0, -1)))) found = await lookup(parts);
      if (!found) return null;
      if (found.kind === "directory") return { kind: "directory", size: 0, mtime: 0 };
      try {
        const file = await found.handle.getFile();
        return { kind: "file", size: file.size, mtime: file.lastModified };
      } catch (e) {
        if (isMissing(e)) return null; // deleted in between
        // The file is there but cannot be read right now (e.g. a writer
        // holds it): it still exists — an existence check must not say no.
        return { kind: "file", size: 0, mtime: 0 };
      }
    },

    async read(path) {
      return await (await fileRecovered(path)).getFile();
    },

    async readText(path) {
      return await (await (await fileRecovered(path)).getFile()).text();
    },

    async write(path, data) {
      const parts = vaultSegments(path);
      await writeAt(parts, data, path);
      emit({ type: "write", path: parts.join("/") });
    },

    async mkdir(path) {
      const parts = vaultSegments(path);
      if (!parts.length) return;
      try {
        await dirAt(parts, true);
      } catch (e) {
        if (isMissing(e)) throw new VaultError("EKIND", path, `Cannot create folder "${path}": a file is in the way`);
        throw e;
      }
      emit({ type: "mkdir", path: parts.join("/") });
    },

    async rename(from, to, opts = {}) {
      const r = checkRename(from, to);
      if (!r) return;
      const target = await lookup(r.dst);
      const source = await lookup(r.src);
      if (!source) throw new VaultNotFoundError(from);
      const alias = !!target && (await sameEntry(source.handle, target.handle));
      if (target && !alias && !opts.overwrite) throw new WorkspaceConflictError(to);
      const dst = r.dst.join("/");
      // The textual checks (checkRename) miss aliases on a case-insensitive
      // or normalising real folder: "Folder" → "folder/sub" is a move into
      // itself, and replacing a folder that holds the source deletes it.
      if (source.kind === "directory") {
        for (const h of await existingAncestors(r.dst)) {
          if (await sameEntry(source.handle, h)) throw new VaultError("EINVAL", to, `Cannot move "${from}" into itself`);
        }
      }
      if (target && !alias && target.kind === "directory") {
        for (const h of await existingAncestors(r.src)) {
          if (await sameEntry(target.handle, h)) throw new VaultError("EINVAL", to, `Cannot replace "${to}" with "${from}", which is inside it`);
        }
      }
      if (alias) {
        // Two spellings of one entry (a case-only or normalisation-only
        // rename on a case-insensitive / normalising real folder): go
        // through a temporary name, or "replacing" the target would delete
        // the source itself.
        const tmp = [...r.dst.slice(0, -1), `.lumen-rename-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`];
        await move(r.src, tmp, source, null);
        const staged = await lookup(tmp);
        if (!staged) throw new VaultNotFoundError(tmp.join("/"));
        try {
          await move(tmp, r.dst, staged, null);
        } catch (e) {
          // Put the entry back under its original name rather than leave it
          // only under the hidden temporary one.
          const left = await lookup(tmp).catch(() => null);
          if (left) await move(tmp, r.src, left, null).catch(() => undefined);
          throw e;
        }
      } else {
        await move(r.src, r.dst, source, target);
      }
      emit({ type: "rename", path: dst, from: r.src.join("/") });
    },

    async remove(path) {
      const parts = vaultSegments(path);
      await removeAt(parts, path);
      emit({ type: "delete", path: parts.join("/") });
    },

    watch: (listener) => events.on(listener),

    notifyExternal: (event) => events.emit({ ...event, origin: "external" }),
  };
}
