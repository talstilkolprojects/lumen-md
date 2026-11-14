/**
 * Plan W4.17 — the directory-handle backend (src/storage/vault/handleBackend.ts)
 * over an in-memory folder that answers like the File System standard
 * (https://fs.spec.whatwg.org): a name of the other kind is a
 * TypeMismatchError, a missing one a NotFoundError, removing a folder that
 * still holds something needs `recursive`, and a writable stream changes the
 * file only when it is closed. helpers/fakeOpfs.ts is more forgiving, so the
 * mutants that only those rules expose survived the contract suite.
 */
import { describe, expect, it } from "vitest";
import { createDirectoryHandleBackend } from "../storage/vault";
import { oldNameFor, tempNameFor } from "../storage/vault/atomic";
import { VaultError, VaultNotFoundError, WorkspaceConflictError, type VaultEvent } from "../storage/vault/types";

const err = (name: string) => new DOMException(name, name);

class StrictFile {
  constructor(public data: Uint8Array = new Uint8Array(), public mtime = 1) {}
}

class StrictFileHandle {
  readonly kind = "file";
  aborted = 0;
  failWrite = false;
  constructor(readonly name: string, readonly file: StrictFile, private sameEntry = true) {}
  get isSameEntry() {
    return this.sameEntry ? async (o: unknown) => o instanceof StrictFileHandle && o.file === this.file : undefined;
  }
  async getFile(): Promise<File> {
    return new File([this.file.data as BlobPart], this.name, { lastModified: this.file.mtime });
  }
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (d: Blob | string | Uint8Array) => {
        if (this.failWrite) throw err("QuotaExceededError");
        chunks.push(typeof d === "string" ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(await d.arrayBuffer()));
      },
      close: async () => {
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        this.file.data = all;
        this.file.mtime++;
      },
      abort: async () => void this.aborted++,
    };
  }
}

class StrictDir {
  readonly kind = "directory";
  readonly children = new Map<string, StrictDir | StrictFile>();
  entriesCalls = 0;
  /** Engines without isSameEntry (it is not everywhere): `sameEntry: false`. */
  constructor(readonly name = "", readonly sameEntry = true, readonly handles: StrictFileHandle[] = []) {}
  get isSameEntry() {
    return this.sameEntry ? async (o: unknown) => o === this : undefined;
  }
  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<StrictDir> {
    const c = this.children.get(name);
    if (c instanceof StrictDir) return c;
    if (c) throw err("TypeMismatchError");
    if (!opts.create) throw err("NotFoundError");
    const d = new StrictDir(name, this.sameEntry, this.handles);
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<StrictFileHandle> {
    let c = this.children.get(name);
    if (c instanceof StrictDir) throw err("TypeMismatchError");
    if (!c) {
      if (!opts.create) throw err("NotFoundError");
      c = new StrictFile();
      this.children.set(name, c);
    }
    const h = new StrictFileHandle(name, c, this.sameEntry);
    this.handles.push(h);
    return h;
  }
  async removeEntry(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const c = this.children.get(name);
    if (!c) throw err("NotFoundError");
    if (c instanceof StrictDir && c.children.size && !opts.recursive) throw err("InvalidModificationError");
    this.children.delete(name);
  }
  async *entries(): AsyncGenerator<[string, StrictDir | StrictFileHandle]> {
    this.entriesCalls++;
    for (const [n, c] of [...this.children]) yield [n, c instanceof StrictDir ? c : new StrictFileHandle(n, c, this.sameEntry)];
  }
  /** Put a file straight into this folder, as another writer would. */
  put(name: string, text: string) {
    this.children.set(name, new StrictFile(new TextEncoder().encode(text)));
  }
}

function setup(opts: { sameEntry?: boolean; writesPending?: () => boolean } = {}) {
  const root = new StrictDir("", opts.sameEntry ?? true);
  const v = createDirectoryHandleBackend({ id: "strict", root: async () => root as unknown as FileSystemDirectoryHandle, writesPending: opts.writesPending });
  const events: VaultEvent[] = [];
  v.watch((e) => events.push(e));
  return { root, v, events };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof VaultError ? e.code : `not a VaultError: ${String(e)}`;
  }
  return "resolved";
};

describe("the directory-handle backend on standard File System handles", () => {
  it("a file or a folder in the way is a vault error, not a raw DOMException", async () => {
    const { v } = setup();
    await v.write("a.md", "A");
    await v.mkdir("dir");
    expect(await code(v.write("a.md/b.md", "x"))).toBe("EKIND");
    expect(await code(v.mkdir("a.md/x"))).toBe("EKIND");
    expect(await code(v.mkdir("a.md"))).toBe("EKIND");
    expect(await code(v.write("dir", "x"))).toBe("EKIND");
    expect(await code(v.write("", "x"))).toBe("EKIND");
    expect(await v.readText("a.md")).toBe("A");
  });

  it("looking through a file as if it were a folder finds nothing", async () => {
    const { v } = setup();
    await v.write("a.md", "AB");
    await v.mkdir("dir/sub");
    expect(await v.stat("a.md/b.md")).toBeNull();
    expect(await v.stat("missing/b.md")).toBeNull();
    expect(await v.stat("a.md")).toEqual({ kind: "file", size: 2, mtime: 2 });
    expect(await v.stat("dir")).toEqual({ kind: "directory", size: 0, mtime: 0 });
    expect(await v.stat("dir/sub")).toEqual({ kind: "directory", size: 0, mtime: 0 });
    expect(await v.stat("")).toEqual({ kind: "directory", size: 0, mtime: 0 });
    for (const p of [v.readText("a.md/b.md"), v.read("dir"), v.readText(""), v.list("a.md"), v.list("nope"), v.remove("a.md/b.md"), v.remove("nope/x.md")]) {
      await expect(p).rejects.toBeInstanceOf(VaultNotFoundError);
    }
    expect(await code(v.remove(""))).toBe("EINVAL");
  });

  it("reading or removing a missing nested path creates no folders on the way", async () => {
    const { root, v } = setup();
    await expect(v.readText("x/y.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    await expect(v.remove("z/y.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect([...root.children.keys()]).toEqual([]);
  });

  it("removes a folder with everything in it", async () => {
    const { v, events } = setup();
    await v.write("d/x/y.md", "y");
    await v.remove("d");
    expect(await v.stat("d")).toBeNull();
    expect(events.at(-1)).toEqual({ type: "delete", path: "d", origin: "self" });
  });

  it("writes nested files, lists them and reports normalised paths", async () => {
    const { v, events } = setup();
    await v.write("/n/a.md", "1");
    await v.mkdir("n/m/");
    await v.mkdir("");
    expect((await v.list("n")).map((e) => [e.name, e.path, e.kind])).toEqual([
      ["m", "n/m", "directory"],
      ["a.md", "n/a.md", "file"],
    ]);
    expect(events).toEqual([
      { type: "write", path: "n/a.md", origin: "self" },
      { type: "mkdir", path: "n/m", origin: "self" },
    ]);
  });

  it("a write that fails aborts its stream and keeps the old content", async () => {
    const { root, v } = setup();
    await v.write("a.md", "old");
    const plain = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, opts) => {
      const h = await plain(name, opts);
      h.failWrite = true;
      return h;
    };
    await expect(v.write("a.md", "new")).rejects.toThrow(/QuotaExceeded/);
    expect(root.handles.at(-1)!.aborted).toBe(1);
    root.getFileHandle = plain;
    expect(await v.readText("a.md")).toBe("old");
  });

  it("without createWritable and without a fallback, says the browser can't write here", async () => {
    const { root, v } = setup();
    const plain = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, opts) => Object.assign(Object.create(null), { kind: "file", getFile: (await plain(name, opts)).getFile });
    await expect(v.write("a.md", "x")).rejects.toThrow("This browser cannot write files here.");
  });
});

describe("renames on standard handles", () => {
  it("replaces a file with a file in place, a folder with a file and a file with a folder", async () => {
    const { v, events } = setup();
    await v.write("a.md", "A");
    await v.write("b.md", "B");
    await v.rename("a.md", "b.md", { overwrite: true });
    expect(await v.readText("b.md")).toBe("A");
    expect(await v.stat("a.md")).toBeNull();
    await v.write("f/inner.md", "I");
    await v.rename("b.md", "f", { overwrite: true });
    expect(await v.readText("f")).toBe("A");
    await v.write("g/x/y.md", "Y");
    await v.rename("g", "f", { overwrite: true });
    expect(await v.readText("f/x/y.md")).toBe("Y");
    expect(await v.stat("g")).toBeNull();
    expect(events.filter((e) => e.type === "rename")).toEqual([
      { type: "rename", path: "b.md", from: "a.md", origin: "self" },
      { type: "rename", path: "f", from: "b.md", origin: "self" },
      { type: "rename", path: "f", from: "g", origin: "self" },
    ]);
  });

  it("a rename whose copy fails keeps a replaced file as it was, and leaves nothing at a new name", async () => {
    const { root, v, events } = setup();
    await v.write("a.md", "A");
    await v.write("b.md", "B");
    const plain = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, opts) => {
      const h = await plain(name, opts);
      if (opts?.create && name !== "a.md") h.failWrite = true;
      return h;
    };
    await expect(v.rename("a.md", "b.md", { overwrite: true })).rejects.toThrow(/QuotaExceeded/);
    await expect(v.rename("a.md", "c.md")).rejects.toThrow(/QuotaExceeded/);
    root.getFileHandle = plain;
    expect([await v.readText("a.md"), await v.readText("b.md"), await v.stat("c.md")]).toEqual(["A", "B", null]);
    expect(events.filter((e) => e.type === "rename")).toEqual([]);
  });

  it("a folder replacing a folder leaves nothing of the old one", async () => {
    const { v } = setup();
    await v.write("old/keep-out.md", "X");
    await v.write("new/a.md", "A");
    await v.rename("new", "old", { overwrite: true });
    expect((await v.list("old")).map((e) => e.name)).toEqual(["a.md"]);
  });

  it("refuses a taken name without overwrite, a missing source, and does nothing for the same name", async () => {
    const { v, events } = setup();
    await v.write("a.md", "A");
    await v.write("b.md", "B");
    await expect(v.rename("a.md", "b.md")).rejects.toBeInstanceOf(WorkspaceConflictError);
    await expect(v.rename("nope.md", "c.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    const before = events.length;
    await v.rename("a.md", "/a.md");
    expect(events.length).toBe(before);
    expect(await v.readText("a.md")).toBe("A");
  });

  it("an engine without isSameEntry treats every other name as another entry", async () => {
    const { v } = setup({ sameEntry: false });
    await v.write("a.md", "A");
    await v.write("b.md", "B");
    await expect(v.rename("a.md", "b.md")).rejects.toBeInstanceOf(WorkspaceConflictError);
    await v.write("d/x.md", "X");
    await v.rename("d", "e/f");
    expect(await v.readText("e/f/x.md")).toBe("X");
  });
});

describe("an interrupted save in the folder", () => {
  it("is finished on read, stat and list, in the root and in a subfolder", async () => {
    const { root, v } = setup();
    root.put(oldNameFor("a.md", "w1"), "old a");
    root.put(tempNameFor("a.md", "w1"), "new a");
    expect(await v.readText("a.md")).toBe("new a");
    const notes = await root.getDirectoryHandle("notes", { create: true });
    notes.put(oldNameFor("b.md", "w2"), "old b");
    expect((await v.stat("notes/b.md"))?.kind).toBe("file");
    expect(await v.readText("notes/b.md")).toBe("old b");
    const more = await root.getDirectoryHandle("more", { create: true });
    more.put(tempNameFor("c.md", "w3"), "torn");
    more.put("c.md", "c");
    expect((await v.list("more")).map((e) => e.name)).toEqual(["c.md"]);
    expect([...more.children.keys()]).toEqual(["c.md"]);
  });

  it("a missing file in a clean folder stays missing, and the folder is scanned once", async () => {
    const { root, v } = setup();
    await v.write("n/a.md", "A");
    const n = await root.getDirectoryHandle("n");
    await expect(v.readText("n/b.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    const scans = n.entriesCalls;
    expect(scans).toBe(1);
    await expect(v.readText("n/c.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect(await v.stat("n/c.md")).toBeNull();
    expect(n.entriesCalls).toBe(scans);
    // A listed folder without leftovers counts as clean too.
    const m = await root.getDirectoryHandle("m", { create: true });
    await v.list("m");
    const listed = m.entriesCalls;
    expect(listed).toBe(1);
    await expect(v.readText("m/x.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect(m.entriesCalls).toBe(listed);
  });

  it("is left alone while a save is still being written", async () => {
    let pending = true;
    const { root, v } = setup({ writesPending: () => pending });
    root.put(oldNameFor("a.md", "w1"), "old a");
    await expect(v.readText("a.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect(await v.stat("a.md")).toBeNull();
    expect(root.children.has(oldNameFor("a.md", "w1"))).toBe(true);
    pending = false;
    expect(await v.readText("a.md")).toBe("old a");
  });
});
