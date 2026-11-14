/**
 * Plan 4.1: the workspace functions are thin wrappers over the active vault
 * backend, and the callers that used to open OPFS themselves (canvases,
 * folder export) now go through the vault too. Run against the in-memory
 * backend: if anything still reached for OPFS, it would find none here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryBackend, getVaultBackend, setVaultBackend, watchVault, type VaultBackend, type VaultEvent } from "../storage/vault";
import {
  createWorkspaceFolder,
  deleteWorkspaceFile,
  isOPFSAvailable,
  listWorkspace,
  listWorkspaceDir,
  listWorkspaceTree,
  readWorkspaceBlob,
  readWorkspaceFile,
  renameWorkspaceFile,
  uniqueWorkspaceName,
  workspaceHasEntry,
  workspaceHasFile,
  WorkspaceConflictError,
  writeWorkspaceBlob,
  writeWorkspaceFile,
} from "../storage/workspace";
import { WORKSPACE_CHANGED, changeOf } from "../storage/workspaceEvents";

let mem: VaultBackend;
let previous: VaultBackend | null;

beforeEach(() => {
  // No OPFS at all: every call below must reach the memory backend.
  Object.defineProperty(navigator, "storage", { configurable: true, value: {} });
  mem = createMemoryBackend();
  previous = setVaultBackend(mem);
});
afterEach(() => {
  setVaultBackend(previous);
});

describe("workspace wrappers over the active vault", () => {
  it("reads and writes through the active backend", async () => {
    expect(getVaultBackend()).toBe(mem);
    expect(isOPFSAvailable()).toBe(true);
    await writeWorkspaceFile("notes/a.md", "# A");
    expect(await mem.readText("notes/a.md")).toBe("# A");
    await mem.write("notes/b.md", "# B");
    expect(await readWorkspaceFile("notes/b.md")).toBe("# B");
    await writeWorkspaceBlob("img/lumen-asset-1.png", new Uint8Array([1, 2]));
    expect([...new Uint8Array(await (await readWorkspaceBlob("img/lumen-asset-1.png")).arrayBuffer())]).toEqual([1, 2]);
  });

  it("keeps the workspace policy: dot entries and assets stay out of listings unless asked", async () => {
    await writeWorkspaceFile("b.md", "b");
    await writeWorkspaceFile("dir/a.md", "a");
    await writeWorkspaceFile(".trash/x/old.md", "old");
    await writeWorkspaceFile(".github/workflows/ci.yml", "ci");
    await writeWorkspaceBlob("dir/lumen-asset-xyz.png", new Uint8Array([0]));

    const tree = await listWorkspaceTree();
    expect(tree.map((n) => n.name)).toEqual(["dir", "b.md"]);
    expect(tree[0].children?.map((n) => n.name)).toEqual(["a.md"]);
    expect(tree[1]).toMatchObject({ path: "b.md", kind: "file", size: 1 });

    const paths = async (o?: Parameters<typeof listWorkspace>[0]) => (await listWorkspace(o)).map((f) => f.path).sort();
    expect(await paths()).toEqual(["b.md", "dir/a.md"]);
    expect(await paths({ includeAssets: true })).toEqual(["b.md", "dir/a.md", "dir/lumen-asset-xyz.png"]);
    // Sync callers see `.github/`, never the trash.
    expect(await paths({ includeHidden: true })).toEqual([".github/workflows/ci.yml", "b.md", "dir/a.md"]);
    expect((await listWorkspaceDir("")).map((e) => e.name)).toEqual([".github", ".trash", "dir", "b.md"]);
  });

  it("existence checks answer false instead of throwing", async () => {
    await writeWorkspaceFile("f/a.md", "a");
    expect(await workspaceHasFile("f/a.md")).toBe(true);
    expect(await workspaceHasFile("f")).toBe(false);
    expect(await workspaceHasEntry("f")).toBe(true);
    expect(await workspaceHasEntry("nope")).toBe(false);
    expect(await workspaceHasEntry("../escape")).toBe(false);
    expect(await uniqueWorkspaceName("f/a.md")).toBe("f/a 2.md");
  });

  it("rename, folders and delete keep their old behaviour", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await expect(renameWorkspaceFile("a.md", "b.md")).rejects.toBeInstanceOf(WorkspaceConflictError);
    await createWorkspaceFolder("box/inner");
    await renameWorkspaceFile("a.md", "box/inner/a.md");
    expect(await readWorkspaceFile("box/inner/a.md")).toBe("A");
    await expect(renameWorkspaceFile("box", "box/inner/x")).rejects.toThrow(/into itself/);
    await deleteWorkspaceFile("box");
    expect(await workspaceHasEntry("box")).toBe(false);
  });
});

describe("watchVault", () => {
  it("follows the active backend across a switch", async () => {
    const got: VaultEvent[] = [];
    const off = watchVault((e) => got.push(e));
    await writeWorkspaceFile("one.md", "1");
    const other = createMemoryBackend();
    setVaultBackend(other);
    await mem.write("old-backend.md", "not active any more");
    await writeWorkspaceFile("two.md", "2");
    off();
    await writeWorkspaceFile("three.md", "3");
    expect(got.map((e) => e.path)).toEqual(["one.md", "two.md"]);
    expect(await other.readText("two.md")).toBe("2");
  });

  it("announces external changes as a structural workspace change", async () => {
    const seen = vi.fn();
    const handler = (e: Event) => seen(changeOf(e));
    window.addEventListener(WORKSPACE_CHANGED, handler);
    try {
      mem.notifyExternal({ type: "rename", path: "new.md", from: "old.md" });
      // Own writes are announced by their callers, as before: not twice.
      await mem.write("own.md", "x");
      expect(seen).toHaveBeenCalledTimes(1);
      expect(seen).toHaveBeenCalledWith({ kind: "structure", paths: ["old.md", "new.md"] });
    } finally {
      window.removeEventListener(WORKSPACE_CHANGED, handler);
    }
  });
});

describe("callers that used to open OPFS themselves", () => {
  it("canvases: a legacy canvas converts through the vault", async () => {
    const { convertLegacyCanvas, listLegacyCanvases } = await import("../ui/CanvasTldraw");
    await mem.write(
      "canvases/board.canvas.json",
      JSON.stringify({ nodes: [{ id: "n1", x: 10, y: 20, width: 100, height: 50, content: "שלום" }] }),
    );
    expect(await listLegacyCanvases()).toEqual(["board"]);
    expect(await convertLegacyCanvas("board")).toEqual({ converted: true, nodeCount: 1 });
    const snap = JSON.parse(await mem.readText("canvases/board.tldr")) as { store: Record<string, { props?: { text?: string } }> };
    expect(snap.store["shape:legacy-n1"].props?.text).toBe("שלום");
  }, 30_000); // the first import of tldraw is slow on a loaded machine

  it("folder export: writes the vault into a picked folder through a directory-handle backend", async () => {
    const { FakeDir } = await import("./helpers/fakeOpfs");
    const { exportVaultToFolder } = await import("../storage/exportAll");
    await writeWorkspaceFile("notes/a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    const picked = new FakeDir("picked");
    await picked.getDirectoryHandle("out", { create: true });
    const r = await exportVaultToFolder(picked as unknown as FileSystemDirectoryHandle, "out");
    expect(r).toEqual({ files: 2, folder: "out 2" });
    const notes = await (await picked.getDirectoryHandle("out 2")).getDirectoryHandle("notes");
    expect(await (await (await notes.getFileHandle("a.md")).getFile()).text()).toBe("A");
  });
});
