/**
 * `.excalidraw` canvas files and the one-shot tldraw migration (plan 4.19).
 * The `.tldr` original is the backup: never written, renamed or deleted.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CanvasFileExistsError,
  createExcalidrawCanvas,
  ExcalidrawFileError,
  isValidCanvasName,
  listExcalidrawCanvases,
  listTldrawCanvases,
  opfsCanvasStore,
  parseExcalidrawFile,
  readExcalidrawCanvas,
  serializeExcalidrawFile,
  writeExcalidrawCanvas,
  type CanvasStore,
} from "../canvas/excalidrawFile";
import { migrateTldrawCanvases, warningLines } from "../canvas/migrateTldrawCanvases";
import { tldrawToExcalidraw } from "../canvas/tldrawToExcalidraw";
import { buildFixtureCanvases } from "./fixtures/tldrawCanvases";

const { toast, alertFn } = vi.hoisted(() => ({
  toast: vi.fn((..._args: unknown[]) => undefined),
  alertFn: vi.fn((..._args: unknown[]) => Promise.resolve(null)),
}));
vi.mock("../ui/AiToast", () => ({ showAiToast: (...a: unknown[]) => toast(...a) }));
vi.mock("../ui/PromptDialog", () => ({ uiAlert: (...a: unknown[]) => alertFn(...a) }));

/** In-memory `canvases/` directory that records every write. */
function memoryStore(initial: Record<string, string> = {}): CanvasStore & { files: Map<string, string>; writes: string[] } {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    files,
    writes,
    async list() {
      return [...files.keys()].sort();
    },
    async read(name) {
      return files.get(name) ?? null;
    },
    async write(name, text) {
      writes.push(name);
      files.set(name, text);
    },
    async create(name, text) {
      if (files.has(name)) throw new CanvasFileExistsError(name);
      writes.push(name);
      files.set(name, text);
    },
    async remove(name, onlyIf) {
      if (files.get(name) !== onlyIf) return false;
      writes.push(`-${name}`);
      files.delete(name);
      return true;
    },
  };
}

const canvases = buildFixtureCanvases();
const scene = tldrawToExcalidraw(canvases[0].data).file;

describe(".excalidraw files", () => {
  it("round-trips a converted scene through write → read", async () => {
    const store = memoryStore();
    await writeExcalidrawCanvas(store, "plan", scene);
    expect(store.writes).toEqual(["plan.excalidraw"]);
    expect(await readExcalidrawCanvas(store, "plan")).toEqual(scene);
    expect(await readExcalidrawCanvas(store, "missing")).toBeNull();
    expect(await listExcalidrawCanvases(store)).toEqual(["plan"]);
  });

  it("writes open, pretty JSON in Excalidraw's own envelope", () => {
    const text = serializeExcalidrawFile(scene);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")[1]).toBe('  "type": "excalidraw",');
    expect(JSON.parse(text)).toMatchObject({ type: "excalidraw", version: 2 });
  });

  it("rejects what isn't an Excalidraw scene", () => {
    const bad = [
      "nope",
      "[]",
      JSON.stringify({ type: "tldraw", version: 2, elements: [] }),
      JSON.stringify({ type: "excalidraw", elements: [] }),
      JSON.stringify({ type: "excalidraw", version: 2, elements: {} }),
      JSON.stringify({ type: "excalidraw", version: 2, elements: [{ type: "rectangle", x: 0, y: 0 }] }),
      JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a", x: 0, y: 0 }] }),
      JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a", type: "text", x: "1", y: 0 }] }),
      JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a", type: "text", x: 0, y: 0 }, { id: "a", type: "text", x: 0, y: 0 }] }),
      JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: { f: { mimeType: "image/png" } } }),
    ];
    for (const text of bad) expect(() => parseExcalidrawFile(text), text).toThrow(ExcalidrawFileError);
  });

  it("fills a missing appState / files and keeps extra appState keys", () => {
    const f = parseExcalidrawFile(JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: { gridSize: 20, theme: "dark" } }));
    expect(f.appState).toEqual({ gridSize: 20, theme: "dark", viewBackgroundColor: "#ffffff" });
    expect(f.files).toEqual({});
    expect(f.source).toBe("");
  });

  it("refuses canvas names that would leave canvases/", async () => {
    for (const name of ["", " ", "a/b", "..\\x", "..", "."]) {
      expect(isValidCanvasName(name), name).toBe(false);
      await expect(writeExcalidrawCanvas(memoryStore(), name, scene)).rejects.toThrow(ExcalidrawFileError);
    }
    expect(isValidCanvasName("לוח תכנון")).toBe(true);
  });

  it("create never overwrites", async () => {
    const store = memoryStore({ "a.excalidraw": "keep" });
    await expect(createExcalidrawCanvas(store, "a", scene)).rejects.toThrow(CanvasFileExistsError);
    expect(store.files.get("a.excalidraw")).toBe("keep");
  });
});

describe("migrating tldraw canvases", () => {
  function vault(): ReturnType<typeof memoryStore> {
    const initial: Record<string, string> = {};
    for (const c of canvases) initial[`${c.name}.tldr`] = JSON.stringify(c.data);
    initial["broken.tldr"] = "{ not json";
    initial["already.tldr"] = JSON.stringify(canvases[0].data);
    initial["already.excalidraw"] = "user's Excalidraw work";
    initial["notes.md"] = "# not a canvas";
    return memoryStore(initial);
  }

  it("converts all twenty canvases, keeps every .tldr untouched, never overwrites", async () => {
    const store = vault();
    const before = new Map(store.files);
    const report = await migrateTldrawCanvases(store, { updated: 1 });
    expect(report.converted.map((c) => c.name)).toEqual(canvases.map((c) => c.name).sort());
    expect(report.skipped).toEqual([{ name: "already", reason: "exists" }]);
    expect(report.failed.map((f) => f.name)).toEqual(["broken"]);
    // Backups: every original file is byte-identical, nothing was deleted.
    for (const [name, text] of before) expect(store.files.get(name), name).toBe(text);
    expect(store.writes.every((w) => w.endsWith(".excalidraw"))).toBe(true);
    expect(store.writes).not.toContain("already.excalidraw");
    // Each new file parses and holds what the converter produced.
    for (const c of canvases) {
      const file = await readExcalidrawCanvas(store, c.name);
      expect(file).toEqual(tldrawToExcalidraw(c.data, { updated: 1 }).file);
      const converted = report.converted.find((x) => x.name === c.name)!;
      expect(converted.shapes).toBe(c.records.filter((r) => r.typeName === "shape").length);
      expect(converted.elements).toBe(file!.elements.length);
    }
    expect(await listTldrawCanvases(store)).toContain("broken");
  });

  it("is harmless to run twice", async () => {
    const store = vault();
    await migrateTldrawCanvases(store, { updated: 1 });
    const after = new Map(store.files);
    const again = await migrateTldrawCanvases(store, { updated: 2 });
    expect(again.converted).toEqual([]);
    expect(again.skipped).toHaveLength(21);
    expect(again.failed.map((f) => f.name)).toEqual(["broken"]);
    expect(store.files).toEqual(after);
  });

  it("takes back an output that doesn't read back, so the next run retries it", async () => {
    const store = vault();
    const read = store.read.bind(store);
    let corrupt = true;
    // Storage hands back a truncated file once: the migration must take it back.
    store.read = async (name) => {
      if (corrupt && name === "01-geo-basic.excalidraw") {
        store.files.set(name, "truncated");
        return "truncated";
      }
      return read(name);
    };
    const first = await migrateTldrawCanvases(store, { updated: 1 });
    expect(first.failed.map((f) => f.name)).toEqual(["01-geo-basic", "broken"]);
    expect(store.files.has("01-geo-basic.excalidraw")).toBe(false);
    expect(store.files.has("01-geo-basic.tldr")).toBe(true);
    corrupt = false;
    const second = await migrateTldrawCanvases(store, { updated: 1 });
    expect(second.converted.map((c) => c.name)).toEqual(["01-geo-basic"]);
    // Only this run's own .excalidraw output was ever removed.
    expect(store.writes.filter((w) => w.startsWith("-"))).toEqual(["-01-geo-basic.excalidraw"]);
  });

  it("keeps a valid scene another tab saved between the create and the readback", async () => {
    const store = vault();
    const read = store.read.bind(store);
    const theirs = serializeExcalidrawFile({ ...scene, source: "other tab" });
    store.read = async (name) => {
      if (name === "03-text.excalidraw") store.files.set(name, theirs);
      return read(name);
    };
    const report = await migrateTldrawCanvases(store, { updated: 1 });
    expect(report.skipped).toContainEqual({ name: "03-text", reason: "exists" });
    expect(store.files.get("03-text.excalidraw")).toBe(theirs);
    expect(store.writes.filter((w) => w.startsWith("-"))).toEqual([]);
  });

  it("lists warnings per canvas and failures", async () => {
    const report = await migrateTldrawCanvases(vault(), { updated: 1 });
    const lines = warningLines(report);
    expect(lines).toContain("07-arrows-edge: elbow-arrow ×1, binding-dropped ×1");
    expect(lines).toContain("12-images-missing: image-not-embedded ×3");
    expect(lines.some((l) => l.startsWith("broken: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("01-geo-basic"))).toBe(false);
  });

  it("the palette command reports counts and the warning list", async () => {
    const { runCanvasMigration } = await import("../canvas/migrateCommand");
    const report = await runCanvasMigration(vault());
    expect(report?.converted).toHaveLength(20);
    expect(toast).toHaveBeenCalled();
    expect(alertFn).toHaveBeenCalled();
    const none = await runCanvasMigration(memoryStore({ "x.md": "" }));
    expect(none?.converted).toEqual([]);
    expect(await runCanvasMigration(null)).toBeNull();
  });
});

describe("OPFS canvas store", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Minimal OPFS: one directory level, files as strings. */
  function fakeOpfs(): Map<string, string> {
    const files = new Map<string, string>();
    const fileHandle = (name: string) => ({
      kind: "file" as const,
      // A real Blob: the vault reads the first bytes to tell an encrypted file (plan 11.4).
      async getFile() {
        return new Blob([files.get(name) ?? ""]);
      },
      async createWritable() {
        let buf = "";
        return {
          async write(t: string) {
            buf += t;
          },
          async close() {
            files.set(name, buf);
          },
        };
      },
    });
    const dir = {
      kind: "directory" as const,
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        // Yield first, so an unserialised check-then-create would race.
        await new Promise((r) => setTimeout(r, 0));
        if (!files.has(name) && !opts?.create) throw new DOMException("missing", "NotFoundError");
        if (!files.has(name)) files.set(name, "");
        return fileHandle(name);
      },
      async removeEntry(name: string) {
        files.delete(name);
      },
      // No sub-folders: the vault's lookup tries a folder after a missing file.
      async getDirectoryHandle(): Promise<never> {
        throw new DOMException("missing", "NotFoundError");
      },
      async *[Symbol.asyncIterator]() {
        for (const name of [...files.keys()]) yield [name, fileHandle(name)];
      },
      // The vault lists a folder with entries(), as OPFS does.
      async *entries() {
        for (const name of [...files.keys()]) yield [name, fileHandle(name)];
      },
    };
    // The vault root: canvases/ is its folder, and the root holds no files (the encrypted
    // vault's header is looked up there first, plan 11.4: it is not there).
    const root = {
      async getDirectoryHandle(name: string) {
        if (name !== "canvases") throw new DOMException("missing", "NotFoundError");
        return dir;
      },
      async getFileHandle(): Promise<never> {
        throw new DOMException("missing", "NotFoundError");
      },
      async *[Symbol.asyncIterator]() {
        yield ["canvases", dir];
      },
      async *entries() {
        yield ["canvases", dir];
      },
    };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    return files;
  }

  it("reads, writes, lists and refuses to overwrite on create", async () => {
    const files = fakeOpfs();
    const store = opfsCanvasStore()!;
    expect(store).not.toBeNull();
    await store.write("a.tldr", "old");
    await createExcalidrawCanvas(store, "a", scene);
    await expect(store.create("a.excalidraw", "x")).rejects.toThrow(CanvasFileExistsError);
    expect(await store.list()).toEqual(["a.excalidraw", "a.tldr"]);
    expect(await store.read("a.tldr")).toBe("old");
    expect(await store.read("nope")).toBeNull();
    expect(parseExcalidrawFile(files.get("a.excalidraw")!)).toEqual(scene);
  });

  it("serialises creates of the same file: exactly one wins, nothing is overwritten", async () => {
    const files = fakeOpfs();
    const store = opfsCanvasStore()!;
    const results = await Promise.allSettled([store.create("x.excalidraw", "first"), store.create("x.excalidraw", "second")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(files.get("x.excalidraw")).toBe("first");
    expect(await store.remove("x.excalidraw", "not what is there")).toBe(false);
    expect(files.get("x.excalidraw")).toBe("first");
    expect(await store.remove("x.excalidraw", "first")).toBe(true);
    expect(files.has("x.excalidraw")).toBe(false);
    await store.write("y.tldr", "backup");
    await expect(store.remove("y.tldr", "backup")).rejects.toThrow(ExcalidrawFileError);
    expect(files.get("y.tldr")).toBe("backup");
  });

  it("create rethrows a lookup failure other than not-found instead of overwriting", async () => {
    const files = fakeOpfs();
    const store = opfsCanvasStore()!;
    await store.write("z.excalidraw", "keep");
    const root = await navigator.storage.getDirectory();
    const d = (await root.getDirectoryHandle("canvases")) as unknown as { getFileHandle: (n: string, o?: { create?: boolean }) => Promise<unknown> };
    const real = d.getFileHandle.bind(d);
    d.getFileHandle = async (n, o) => {
      if (!o?.create) throw new DOMException("io", "InvalidStateError");
      return real(n, o);
    };
    await expect(store.create("z.excalidraw", "new")).rejects.toThrow("io");
    expect(files.get("z.excalidraw")).toBe("keep");
  });

  it("is null without OPFS", () => {
    vi.stubGlobal("navigator", {});
    expect(opfsCanvasStore()).toBeNull();
  });
});
