/**
 * The VaultBackend contract (plan 4.1). Every backend runs the same suite:
 * the OPFS backend on the in-memory fake OPFS, the directory-handle backend
 * on a fake picked folder (what the Chromium real-folder vault and the
 * folder export use), and the pure in-memory backend. A new backend (Tauri
 * fs, 4.2) joins by adding one line to `backends`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDir, installFakeOpfs } from "./helpers/fakeOpfs";
import {
  createDirectoryHandleBackend,
  createMemoryBackend,
  createOpfsBackend,
  VaultError,
  VaultNotFoundError,
  WorkspaceConflictError,
  type VaultBackend,
  type VaultEvent,
} from "../storage/vault";
import { createFolderBackend } from "../storage/vault/location";

const backends: [string, () => VaultBackend][] = [
  [
    "opfs (fake OPFS)",
    () => {
      installFakeOpfs();
      return createOpfsBackend();
    },
  ],
  [
    "directory handle (fake picked folder)",
    () => {
      const dir = new FakeDir("picked");
      return createDirectoryHandleBackend({ id: "folder", root: async () => dir as unknown as FileSystemDirectoryHandle });
    },
  ],
  [
    "folder vault (plan 4.2, fake picked folder)",
    () => createFolderBackend(new FakeDir("My Vault") as unknown as FileSystemDirectoryHandle),
  ],
  ["memory", () => createMemoryBackend()],
];

const bytesOf = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

describe.each(backends)("VaultBackend contract — %s", (_label, make) => {
  let v: VaultBackend;
  beforeEach(() => {
    v = make();
  });
  const names = async (dir: string) => (await v.list(dir)).map((e) => e.name);
  const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof VaultError ? e.code : `not a VaultError: ${String(e)}`));

  it("is available", () => {
    expect(v.available()).toBe(true);
  });

  describe("create / read / overwrite", () => {
    it("writes a new file and reads it back as text and as bytes", async () => {
      await v.write("a.md", "# Hello\n");
      expect(await v.readText("a.md")).toBe("# Hello\n");
      expect(await bytesOf(await v.read("a.md"))).toEqual([...new TextEncoder().encode("# Hello\n")]);
    });

    it("overwrites in place, shorter content leaving nothing of the old", async () => {
      await v.write("a.md", "a long first version");
      await v.write("a.md", "short");
      expect(await v.readText("a.md")).toBe("short");
      expect((await v.stat("a.md"))?.size).toBe(5);
      expect(await names("")).toEqual(["a.md"]);
    });

    it("round-trips bytes from a Uint8Array, an ArrayBuffer and a Blob", async () => {
      const raw = [0, 255, 128, 10, 13, 0];
      await v.write("u8.bin", new Uint8Array(raw));
      await v.write("ab.bin", new Uint8Array(raw).buffer);
      await v.write("blob.bin", new Blob([new Uint8Array(raw)]));
      for (const p of ["u8.bin", "ab.bin", "blob.bin"]) expect(await bytesOf(await v.read(p))).toEqual(raw);
    });

    it("keeps its own copy: changing the written array afterwards changes nothing", async () => {
      const data = new Uint8Array([1, 2, 3]);
      await v.write("c.bin", data);
      data[0] = 9;
      expect(await bytesOf(await v.read("c.bin"))).toEqual([1, 2, 3]);
    });

    it("an empty file is a file of size 0", async () => {
      await v.write("empty.md", "");
      expect(await v.readText("empty.md")).toBe("");
      expect(await v.stat("empty.md")).toMatchObject({ kind: "file", size: 0 });
    });
  });

  describe("nested folders", () => {
    it("a write creates the missing parent folders", async () => {
      await v.write("a/b/c/note.md", "deep");
      expect(await v.readText("a/b/c/note.md")).toBe("deep");
      expect((await v.stat("a"))?.kind).toBe("directory");
      expect((await v.stat("a/b/c"))?.kind).toBe("directory");
      expect(await names("a/b")).toEqual(["c"]);
    });

    it("mkdir creates parents, is idempotent, and '' is a no-op", async () => {
      await v.mkdir("x/y/z");
      await v.mkdir("x/y/z");
      await v.mkdir("");
      expect((await v.stat("x/y/z"))?.kind).toBe("directory");
      expect(await v.list("x/y/z")).toEqual([]);
    });

    it("treats empty segments and a leading slash as the same path", async () => {
      await v.write("/n//sub/a.md", "x");
      expect(await v.readText("n/sub/a.md")).toBe("x");
      expect((await v.list("n/sub"))[0].path).toBe("n/sub/a.md");
    });
  });

  describe("rename", () => {
    it("renames a file: content at the new path, nothing at the old", async () => {
      await v.write("old.md", "body");
      await v.rename("old.md", "new.md");
      expect(await v.readText("new.md")).toBe("body");
      expect(await v.stat("old.md")).toBeNull();
    });

    it("moves a file into a folder that does not exist yet", async () => {
      await v.write("a.md", "A");
      await v.rename("a.md", "archive/2026/a.md");
      expect(await v.readText("archive/2026/a.md")).toBe("A");
      expect(await names("")).toEqual(["archive"]);
    });

    it("moves a folder with everything inside it", async () => {
      await v.write("p/one.md", "1");
      await v.write("p/sub/two.md", "2");
      await v.write("p/sub/deeper/three.bin", new Uint8Array([3]));
      await v.mkdir("p/empty");
      await v.rename("p", "q/moved");
      expect(await v.stat("p")).toBeNull();
      expect(await v.readText("q/moved/one.md")).toBe("1");
      expect(await v.readText("q/moved/sub/two.md")).toBe("2");
      expect(await bytesOf(await v.read("q/moved/sub/deeper/three.bin"))).toEqual([3]);
      expect((await v.stat("q/moved/empty"))?.kind).toBe("directory");
    });

    it("refuses to replace a file or a folder without overwrite, changing nothing", async () => {
      await v.write("a.md", "A");
      await v.write("b.md", "B");
      await v.write("dir/x.md", "X");
      await expect(v.rename("a.md", "b.md")).rejects.toBeInstanceOf(WorkspaceConflictError);
      await expect(v.rename("a.md", "dir")).rejects.toBeInstanceOf(WorkspaceConflictError);
      expect(await code(v.rename("a.md", "b.md"))).toBe("EEXIST");
      expect(await v.readText("a.md")).toBe("A");
      expect(await v.readText("b.md")).toBe("B");
      expect(await v.readText("dir/x.md")).toBe("X");
    });

    it("with overwrite, replaces the target (a folder is replaced, not merged)", async () => {
      await v.write("a.md", "A");
      await v.write("b.md", "B");
      await v.rename("a.md", "b.md", { overwrite: true });
      expect(await v.readText("b.md")).toBe("A");
      expect(await v.stat("a.md")).toBeNull();

      await v.write("src/new.md", "new");
      await v.write("dst/old.md", "old");
      await v.rename("src", "dst", { overwrite: true });
      expect(await names("dst")).toEqual(["new.md"]);
      expect(await v.stat("src")).toBeNull();
    });

    it("refuses to move a folder into itself", async () => {
      await v.write("p/a.md", "A");
      await expect(v.rename("p", "p/inner")).rejects.toThrow(/into itself/);
      expect(await code(v.rename("p", "p/inner/deeper"))).toBe("EINVAL");
      expect(await v.readText("p/a.md")).toBe("A");
      expect(await names("p")).toEqual(["a.md"]);
    });

    it("refuses to replace a folder with something inside it, even with overwrite", async () => {
      await v.write("a/b/c.md", "C");
      expect(await code(v.rename("a/b", "a", { overwrite: true }))).toBe("EINVAL");
      expect(await code(v.rename("a/b/c.md", "a", { overwrite: true }))).toBe("EINVAL");
      expect(await v.readText("a/b/c.md")).toBe("C");
    });

    it("the same path is a no-op; a change of letter case is a rename", async () => {
      await v.write("Note.md", "N");
      await v.rename("Note.md", "Note.md");
      expect(await v.readText("Note.md")).toBe("N");
      await v.rename("Note.md", "note.md");
      expect(await names("")).toEqual(["note.md"]);
      expect(await v.readText("note.md")).toBe("N");
    });

    it("rejects with VaultNotFoundError when nothing is at the source", async () => {
      await expect(v.rename("missing.md", "x.md")).rejects.toBeInstanceOf(VaultNotFoundError);
      expect(await v.stat("x.md")).toBeNull();
      // Even when something is at the target: a missing source is not a conflict.
      await v.write("existing.md", "E");
      await expect(v.rename("missing.md", "existing.md")).rejects.toBeInstanceOf(VaultNotFoundError);
      expect(await v.readText("existing.md")).toBe("E");
    });

    it("refuses to move the root", async () => {
      await v.write("a.md", "A");
      expect(await code(v.rename("", "x"))).toBe("EINVAL");
      expect(await code(v.rename("a.md", ""))).toBe("EINVAL");
    });
  });

  describe("delete", () => {
    it("deletes a file and leaves its folder", async () => {
      await v.write("d/a.md", "A");
      await v.write("d/b.md", "B");
      await v.remove("d/a.md");
      expect(await v.stat("d/a.md")).toBeNull();
      expect(await names("d")).toEqual(["b.md"]);
    });

    it("deletes a folder recursively", async () => {
      await v.write("d/sub/a.md", "A");
      await v.write("d/b.md", "B");
      await v.write("keep.md", "K");
      await v.remove("d");
      expect(await v.stat("d")).toBeNull();
      expect(await v.stat("d/sub/a.md")).toBeNull();
      expect(await names("")).toEqual(["keep.md"]);
    });

    it("rejects for a missing entry and for the root", async () => {
      await expect(v.remove("nope.md")).rejects.toBeInstanceOf(VaultNotFoundError);
      await expect(v.remove("no/such/dir.md")).rejects.toBeInstanceOf(VaultNotFoundError);
      expect(await code(v.remove(""))).toBe("EINVAL");
    });
  });

  describe("stat", () => {
    it("reports a file's kind, size in bytes and mtime", async () => {
      const before = Date.now();
      await v.write("s.md", "12345");
      const after = Date.now();
      const s = await v.stat("s.md");
      expect(s).toMatchObject({ kind: "file", size: 5 });
      expect(s!.mtime).toBeGreaterThanOrEqual(before);
      expect(s!.mtime).toBeLessThanOrEqual(after);
    });

    it("an overwrite moves mtime forward (or keeps it, within the clock's resolution)", async () => {
      await v.write("s.md", "1");
      const first = (await v.stat("s.md"))!.mtime;
      await new Promise((r) => setTimeout(r, 5));
      await v.write("s.md", "22");
      const second = (await v.stat("s.md"))!;
      expect(second.size).toBe(2);
      expect(second.mtime).toBeGreaterThanOrEqual(first);
    });

    it("reports folders (the root included) and null for nothing", async () => {
      await v.mkdir("f");
      await v.write("file.md", "x");
      expect(await v.stat("f")).toMatchObject({ kind: "directory", size: 0 });
      expect((await v.stat(""))?.kind).toBe("directory");
      expect(await v.stat("missing.md")).toBeNull();
      expect(await v.stat("missing/dir/x.md")).toBeNull();
      expect(await v.stat("file.md/below")).toBeNull();
    });
  });

  describe("list", () => {
    it("lists direct children: folders first, then files, each by name", async () => {
      await v.write("b.md", "b");
      await v.write("c.txt", "c");
      await v.write("a.md", "a");
      await v.mkdir("zeta");
      await v.write("alpha/inside.md", "i");
      expect(await names("")).toEqual(["alpha", "zeta", "a.md", "b.md", "c.txt"]);
    });

    it("gives each entry its full path and kind, and files their size and mtime", async () => {
      await v.write("n/a.md", "abc");
      await v.mkdir("n/sub");
      const list = await v.list("n");
      expect(list.map(({ name, path, kind }) => ({ name, path, kind }))).toEqual([
        { name: "sub", path: "n/sub", kind: "directory" },
        { name: "a.md", path: "n/a.md", kind: "file" },
      ]);
      expect(list[1].size).toBe(3);
      expect(list[1].mtime).toBeGreaterThan(0);
    });

    it("includes dot entries (hiding them is the caller's policy)", async () => {
      await v.write(".trash/index.json", "[]");
      await v.write("note.md", "n");
      expect(await names("")).toEqual([".trash", "note.md"]);
    });

    it("an empty vault lists nothing", async () => {
      expect(await v.list("")).toEqual([]);
    });
  });

  describe("errors", () => {
    it("reading a missing file rejects with VaultNotFoundError carrying the path", async () => {
      const err = await v.readText("nope.md").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VaultNotFoundError);
      expect((err as VaultNotFoundError).code).toBe("ENOENT");
      expect((err as VaultNotFoundError).path).toBe("nope.md");
      await expect(v.read("no/such/folder/x.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    });

    it("reading a folder, or listing a file or a missing folder, is not found", async () => {
      await v.write("dir/a.md", "a");
      await expect(v.readText("dir")).rejects.toBeInstanceOf(VaultNotFoundError);
      await expect(v.list("dir/a.md")).rejects.toBeInstanceOf(VaultNotFoundError);
      await expect(v.list("missing")).rejects.toBeInstanceOf(VaultNotFoundError);
    });

    it("a file where a folder is needed, or a folder where a file is needed, is EKIND", async () => {
      await v.write("a.md", "a");
      await v.mkdir("dir");
      expect(await code(v.write("dir", "x"))).toBe("EKIND");
      expect(await code(v.write("a.md/below.md", "x"))).toBe("EKIND");
      expect(await code(v.mkdir("a.md"))).toBe("EKIND");
      expect(await code(v.mkdir("a.md/sub"))).toBe("EKIND");
      expect(await code(v.write("", "x"))).toBe("EKIND");
      expect(await v.readText("a.md")).toBe("a");
    });

    it("refuses paths that would leave the vault", async () => {
      await v.write("a.md", "a");
      for (const p of ["../x.md", "a/../../x.md", "./a.md", ".."]) {
        expect(await code(v.readText(p))).toBe("EINVAL");
        expect(await code(v.write(p, "x"))).toBe("EINVAL");
      }
      expect(await code(v.list(".."))).toBe("EINVAL");
      expect(await code(v.stat("../a.md"))).toBe("EINVAL");
      expect(await code(v.rename("a.md", "../a.md"))).toBe("EINVAL");
      expect(await code(v.remove("x/../a.md"))).toBe("EINVAL");
      expect(await v.readText("a.md")).toBe("a");
    });
  });

  describe("Unicode names", () => {
    it("stores, lists, renames and deletes Hebrew, Arabic, Japanese and emoji names", async () => {
      const text = "שלום עולם — مرحبا — こんにちは 🎉";
      await v.write("פרויקטים/סיכום 2026.md", text);
      await v.write("ملاحظات/日本語 メモ.md", "メモ");
      await v.write("🎉 party.md", "🎉");
      expect(await v.readText("פרויקטים/סיכום 2026.md")).toBe(text);
      expect((await v.stat("פרויקטים/סיכום 2026.md"))?.size).toBe(new TextEncoder().encode(text).byteLength);
      expect(await names("פרויקטים")).toEqual(["סיכום 2026.md"]);
      expect(await names("ملاحظات")).toEqual(["日本語 メモ.md"]);

      await v.rename("פרויקטים", "ארכיון/פרויקטים ישנים");
      expect(await v.readText("ארכיון/פרויקטים ישנים/סיכום 2026.md")).toBe(text);
      expect(await v.stat("פרויקטים")).toBeNull();

      await v.remove("🎉 party.md");
      expect(await v.stat("🎉 party.md")).toBeNull();
    });
  });

  describe("watch", () => {
    it("fires one event per own write, mkdir, rename and delete", async () => {
      const got: VaultEvent[] = [];
      v.watch((e) => got.push(e));
      await v.write("/a.md", "A");
      await v.mkdir("d/sub");
      await v.write("d/sub/x.md", "x");
      await v.write("d/y.md", "y");
      await v.rename("d", "e"); // a folder move: one event, not one per copied file
      await v.rename("a.md", "b.md");
      await v.remove("e");
      expect(got).toEqual([
        { type: "write", path: "a.md", origin: "self" },
        { type: "mkdir", path: "d/sub", origin: "self" },
        { type: "write", path: "d/sub/x.md", origin: "self" },
        { type: "write", path: "d/y.md", origin: "self" },
        { type: "rename", path: "e", from: "d", origin: "self" },
        { type: "rename", path: "b.md", from: "a.md", origin: "self" },
        { type: "delete", path: "e", origin: "self" },
      ]);
    });

    it("fires nothing for reads, failed operations and no-ops", async () => {
      await v.write("a.md", "A");
      await v.write("b.md", "B");
      const got: VaultEvent[] = [];
      v.watch((e) => got.push(e));
      await v.readText("a.md");
      await v.list("");
      await v.stat("a.md");
      await v.rename("a.md", "a.md");
      await v.rename("a.md", "b.md").catch(() => undefined);
      await v.remove("missing.md").catch(() => undefined);
      await v.readText("missing.md").catch(() => undefined);
      await v.write("a.md/x", "x").catch(() => undefined);
      expect(got).toEqual([]);
    });

    it("stops after unsubscribe; a throwing listener fails neither the write nor other listeners", async () => {
      const a = vi.fn();
      const b = vi.fn();
      const off = v.watch(a);
      v.watch(() => {
        throw new Error("listener bug");
      });
      v.watch(b);
      await v.write("x.md", "1");
      off();
      await v.write("x.md", "2");
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(2);
      expect(await v.readText("x.md")).toBe("2");
    });

    it("delivers external changes reported through notifyExternal", () => {
      const got: VaultEvent[] = [];
      v.watch((e) => got.push(e));
      v.notifyExternal({ type: "write", path: "edited elsewhere.md" });
      v.notifyExternal({ type: "rename", path: "new.md", from: "old.md" });
      expect(got).toEqual([
        { type: "write", path: "edited elsewhere.md", origin: "external" },
        { type: "rename", path: "new.md", from: "old.md", origin: "external" },
      ]);
    });
  });
});

// A picked folder on macOS / Windows: names match whatever their case.
class CaseInsensitiveDir extends FakeDir {
  private key<T>(m: Map<string, T>, name: string): string {
    for (const k of m.keys()) if (k.toLowerCase() === name.toLowerCase()) return k;
    return name;
  }
  override async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDir> {
    if (!this.dirs.has(this.key(this.dirs, name)) && opts.create) this.dirs.set(name, new CaseInsensitiveDir(name));
    return super.getDirectoryHandle(this.key(this.dirs, name), opts);
  }
  override async getFileHandle(name: string, opts: { create?: boolean } = {}) {
    return super.getFileHandle(this.key(this.files, name), opts);
  }
  override async removeEntry(name: string): Promise<void> {
    return super.removeEntry(this.files.has(this.key(this.files, name)) ? this.key(this.files, name) : this.key(this.dirs, name));
  }
}

describe("directory-handle backend specifics", () => {
  it("writes through the fallback when a file handle has no createWritable (OPFS on WebKit)", async () => {
    const dir = new FakeDir();
    const plain = dir.getFileHandle.bind(dir);
    // A WebKit-like handle: everything but createWritable.
    dir.getFileHandle = (async (name: string, opts?: { create?: boolean }) => {
      const h = await plain(name, opts);
      return Object.assign(Object.create(null), { kind: h.kind, name: h.name, getFile: () => h.getFile() });
    }) as typeof dir.getFileHandle;
    const fallback = vi.fn(async () => undefined);
    const v = createDirectoryHandleBackend({ id: "webkit", root: async () => dir as unknown as FileSystemDirectoryHandle, writeFallback: fallback });
    const events: VaultEvent[] = [];
    v.watch((e) => events.push(e));
    await v.write("/a.md", "hello");
    expect(fallback).toHaveBeenCalledWith(["a.md"], "hello");
    expect(events).toEqual([{ type: "write", path: "a.md", origin: "self" }]);
  });

  it.each([
    ["into a new folder", false],
    ["replacing an existing folder (overwrite)", true],
  ])("a rename whose copy fails removes the partial target and keeps the source — %s", async (_l, overwrite) => {
    const dir = new FakeDir();
    const v = createDirectoryHandleBackend({ id: "t", root: async () => dir as unknown as FileSystemDirectoryHandle });
    await v.write("p/a.md", "A");
    await v.write("p/b.md", "B");
    if (overwrite) await v.write("q/old.md", "old");
    const plain = dir.getDirectoryHandle.bind(dir);
    const patched = new WeakSet<object>();
    // The copy of the second file fails, as a full quota would.
    dir.getDirectoryHandle = (async (name: string, opts?: { create?: boolean }) => {
      const d = await plain(name, opts);
      if (name === "q" && !patched.has(d)) {
        patched.add(d);
        const getFile = d.getFileHandle.bind(d);
        d.getFileHandle = (async (n: string, o?: { create?: boolean }) => {
          if (o?.create && n === "b.md") throw new DOMException("quota", "QuotaExceededError");
          return getFile(n, o);
        }) as typeof d.getFileHandle;
      }
      return d;
    }) as typeof dir.getDirectoryHandle;
    await expect(v.rename("p", "q", { overwrite })).rejects.toThrow(/quota/);
    // Nothing half-copied at the target (the replaced folder was given up by request).
    expect(await v.stat("q")).toBeNull();
    expect(await v.readText("p/a.md")).toBe("A");
    expect(await v.readText("p/b.md")).toBe("B");
  });

  it("a case-only rename on a case-insensitive folder goes through a temporary name instead of deleting the file", async () => {
    const dir = new CaseInsensitiveDir();
    const v = createDirectoryHandleBackend({ id: "ci", root: async () => dir as unknown as FileSystemDirectoryHandle });
    await v.write("Note.md", "keep me");
    await v.write("Folder/inside.md", "in");
    await v.rename("Note.md", "note.md");
    await v.rename("Folder", "folder", { overwrite: true });
    expect((await v.list("")).map((e) => e.name)).toEqual(["folder", "note.md"]);
    expect(await v.readText("note.md")).toBe("keep me");
    expect(await v.readText("folder/inside.md")).toBe("in");
    // A real conflict (a different entry) is still refused.
    await v.write("other.md", "o");
    await expect(v.rename("other.md", "NOTE.md")).rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it("on a case-insensitive folder, aliases of the source's own folders are caught too", async () => {
    const dir = new CaseInsensitiveDir();
    const v = createDirectoryHandleBackend({ id: "ci", root: async () => dir as unknown as FileSystemDirectoryHandle });
    await v.write("Folder/a.md", "A");
    await expect(v.rename("Folder", "folder/sub")).rejects.toThrow(/into itself/);
    await v.write("Box/inner/b.md", "B");
    await expect(v.rename("Box/inner", "box", { overwrite: true })).rejects.toThrow(/inside it/);
    expect(await v.readText("Folder/a.md")).toBe("A");
    expect(await v.readText("Box/inner/b.md")).toBe("B");
  });

  it("a case-only rename whose second step fails puts the entry back under its original name", async () => {
    const dir = new CaseInsensitiveDir();
    const v = createDirectoryHandleBackend({ id: "ci", root: async () => dir as unknown as FileSystemDirectoryHandle });
    await v.write("Note.md", "keep me");
    const plain = dir.getFileHandle.bind(dir);
    dir.getFileHandle = (async (name: string, opts?: { create?: boolean }) => {
      if (opts?.create && name === "note.md") throw new DOMException("quota", "QuotaExceededError");
      return plain(name, opts);
    }) as typeof dir.getFileHandle;
    await expect(v.rename("Note.md", "note.md")).rejects.toThrow(/quota/);
    expect((await v.list("")).map((e) => e.name)).toEqual(["Note.md"]);
    expect(await v.readText("Note.md")).toBe("keep me");
  });

  it("a file that exists but cannot be read right now still exists for stat", async () => {
    const dir = new FakeDir();
    const v = createDirectoryHandleBackend({ id: "t", root: async () => dir as unknown as FileSystemDirectoryHandle });
    await v.write("busy.md", "x");
    const plain = dir.getFileHandle.bind(dir);
    dir.getFileHandle = (async (name: string, opts?: { create?: boolean }) => {
      const h = await plain(name, opts);
      h.getFile = async () => {
        throw new DOMException("locked", "NoModificationAllowedError");
      };
      return h;
    }) as typeof dir.getFileHandle;
    expect(await v.stat("busy.md")).toEqual({ kind: "file", size: 0, mtime: 0 });
    expect(await v.stat("gone.md")).toBeNull();
  });

  it("the OPFS backend says so when the browser has no OPFS", async () => {
    Object.defineProperty(navigator, "storage", { configurable: true, value: {} });
    const v = createOpfsBackend();
    expect(v.available()).toBe(false);
    await expect(v.readText("a.md")).rejects.toThrow(/OPFS is not available/);
  });
});
