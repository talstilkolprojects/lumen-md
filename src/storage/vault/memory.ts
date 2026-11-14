/**
 * A vault backend held in memory — the reference implementation of the
 * VaultBackend contract with no browser API underneath. The contract suite
 * runs against it next to OPFS, and tests (or a future demo / no-storage
 * mode) can make it the active vault with `setVaultBackend`.
 *
 * Semantics follow OPFS: case-sensitive names, no normalisation, rename
 * moves the entry itself (so it keeps its mtime).
 */

import { checkRename, compareVaultEntries, toBytes, VaultEmitter, vaultSegments } from "./shared";
import {
  VaultError,
  VaultNotFoundError,
  WorkspaceConflictError,
  type VaultBackend,
  type VaultEntry,
  type VaultEvent,
} from "./types";

interface MemFile {
  kind: "file";
  data: Uint8Array;
  mtime: number;
}
interface MemDir {
  kind: "directory";
  children: Map<string, MemNode>;
}
type MemNode = MemFile | MemDir;

const newDir = (): MemDir => ({ kind: "directory", children: new Map() });

export function createMemoryBackend(opts: { id?: string; now?: () => number } = {}): VaultBackend {
  const root = newDir();
  const now = opts.now ?? Date.now;
  const events = new VaultEmitter();
  const emit = (e: Omit<VaultEvent, "origin">) => events.emit({ ...e, origin: "self" });

  function nodeAt(parts: string[]): MemNode | null {
    let cur: MemNode = root;
    for (const p of parts) {
      if (cur.kind !== "directory") return null;
      const next = cur.children.get(p);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /** The directory at `parts`, created (with parents) when `create`; null when missing or a file is in the way. */
  function dirAt(parts: string[], create: boolean): MemDir | null {
    let cur: MemDir = root;
    for (const p of parts) {
      let next = cur.children.get(p);
      if (!next) {
        if (!create) return null;
        next = newDir();
        cur.children.set(p, next);
      }
      if (next.kind !== "directory") return null;
      cur = next;
    }
    return cur;
  }

  function fileAt(parts: string[], path: string): MemFile {
    const n = parts.length ? nodeAt(parts) : null;
    if (!n || n.kind !== "file") throw new VaultNotFoundError(path);
    return n;
  }

  return {
    id: opts.id ?? "memory",

    available: () => true,

    async list(dir) {
      const parts = vaultSegments(dir);
      const d = nodeAt(parts);
      if (!d || d.kind !== "directory") throw new VaultNotFoundError(dir);
      const out: VaultEntry[] = [];
      for (const [name, n] of d.children) {
        const path = [...parts, name].join("/");
        out.push(n.kind === "file" ? { name, path, kind: "file", size: n.data.byteLength, mtime: n.mtime } : { name, path, kind: "directory" });
      }
      return out.sort(compareVaultEntries);
    },

    async stat(path) {
      const n = nodeAt(vaultSegments(path));
      if (!n) return null;
      return n.kind === "file" ? { kind: "file", size: n.data.byteLength, mtime: n.mtime } : { kind: "directory", size: 0, mtime: 0 };
    },

    async read(path) {
      return new Blob([fileAt(vaultSegments(path), path).data.slice() as BlobPart]);
    },

    async readText(path) {
      return new TextDecoder().decode(fileAt(vaultSegments(path), path).data);
    },

    async write(path, data) {
      const parts = vaultSegments(path);
      if (!parts.length) throw new VaultError("EKIND", path, "Cannot write to the vault root");
      const bytes = await toBytes(data);
      const name = parts[parts.length - 1];
      const dir = dirAt(parts.slice(0, -1), true);
      const existing = dir?.children.get(name);
      if (!dir || existing?.kind === "directory") {
        throw new VaultError("EKIND", path, `Cannot write "${path}": a file or folder of that name is in the way`);
      }
      dir.children.set(name, { kind: "file", data: bytes, mtime: now() });
      emit({ type: "write", path: parts.join("/") });
    },

    async mkdir(path) {
      const parts = vaultSegments(path);
      if (!parts.length) return;
      if (!dirAt(parts, true)) throw new VaultError("EKIND", path, `Cannot create folder "${path}": a file is in the way`);
      emit({ type: "mkdir", path: parts.join("/") });
    },

    async rename(from, to, o = {}) {
      const r = checkRename(from, to);
      if (!r) return;
      const source = nodeAt(r.src);
      if (!source) throw new VaultNotFoundError(from);
      const target = nodeAt(r.dst);
      if (target && !o.overwrite) throw new WorkspaceConflictError(to);
      const toParent = dirAt(r.dst.slice(0, -1), true);
      if (!toParent) throw new VaultError("EKIND", to, `Cannot move to "${to}": a file is in the way`);
      const fromParent = dirAt(r.src.slice(0, -1), false)!;
      fromParent.children.delete(r.src[r.src.length - 1]);
      toParent.children.set(r.dst[r.dst.length - 1], source);
      emit({ type: "rename", path: r.dst.join("/"), from: r.src.join("/") });
    },

    async remove(path) {
      const parts = vaultSegments(path);
      if (!parts.length) throw new VaultError("EINVAL", path, "Cannot delete the workspace root");
      const parent = dirAt(parts.slice(0, -1), false);
      if (!parent || !parent.children.delete(parts[parts.length - 1])) throw new VaultNotFoundError(path);
      emit({ type: "delete", path: parts.join("/") });
    },

    watch: (listener) => events.on(listener),

    notifyExternal: (event) => events.emit({ ...event, origin: "external" }),
  };
}
