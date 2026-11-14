/**
 * Plan 4.2: the vault in a real folder. Moving copies, verifies byte for
 * byte, then switches; never deletes the source; stops before writing when
 * the target differs; resumes after an interruption. A folder whose
 * permission needs a click is "disconnected" until reconnected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDir, installFakeOpfs } from "./helpers/fakeOpfs";
import { getVaultBackend, createMemoryBackend, createOpfsBackend, setVaultBackend } from "../storage/vault";
import {
  __resetVaultLocation,
  __setLocationStore,
  cancelPendingMove,
  getPendingMove,
  getVaultStatus,
  isFolderVaultSupported,
  moveVault,
  openFolderAsVault,
  reconnectVaultFolder,
  restoreVaultLocation,
  restoreVaultLocationWithin,
  setOnVaultReplaced,
  switchToBrowserStorage,
  VaultMoveConflictError,
  VaultPermissionError,
  type StoredLocation,
} from "../storage/vault/location";
import { readWorkspaceFile, writeWorkspaceBlob, writeWorkspaceFile, isOPFSAvailable } from "../storage/workspace";

const store = new Map<string, unknown>();
const kv = { get: async <T,>(k: string) => store.get(k) as T | undefined, set: async (k: string, v: unknown) => void store.set(k, v), del: async (k: string) => void store.delete(k) };

type Perm = "granted" | "prompt" | "denied";
/** A picked folder with the File System Access permission API. */
function folder(name = "My Vault", perm: { state: Perm; onRequest?: Perm } = { state: "granted" }) {
  const dir = new FakeDir(name) as FakeDir & {
    queryPermission: () => Promise<Perm>;
    requestPermission: () => Promise<Perm>;
  };
  dir.queryPermission = async () => perm.state;
  dir.requestPermission = async () => (perm.state = perm.onRequest ?? perm.state);
  return { dir, handle: dir as unknown as FileSystemDirectoryHandle, perm };
}
const loc = (f: ReturnType<typeof folder>): StoredLocation => ({ kind: "folder", handle: f.handle, name: f.dir.name });
const bytesAt = async (d: FakeDir, path: string) => {
  const parts = path.split("/");
  let cur = d;
  for (const p of parts.slice(0, -1)) cur = await cur.getDirectoryHandle(p);
  return [...new Uint8Array(await (await (await cur.getFileHandle(parts[parts.length - 1])).getFile()).arrayBuffer())];
};

beforeEach(() => {
  store.clear();
  __setLocationStore(kv);
  installFakeOpfs();
  __resetVaultLocation();
});
afterEach(() => __resetVaultLocation());

async function seed() {
  await writeWorkspaceFile("a.md", "# A\n");
  await writeWorkspaceFile("פרויקטים/סיכום.md", "שלום עולם");
  await writeWorkspaceBlob("img/lumen-asset-1.png", new Uint8Array([0, 255, 7]));
  await writeWorkspaceFile(".trash/index.json", "[]");
}

describe("moving the vault into a folder", () => {
  it("copies every file (trash included), byte for byte, then works in the folder; the source stays", async () => {
    await seed();
    const opfs = createOpfsBackend();
    const f = folder();
    const seen: number[] = [];
    const r = await moveVault(loc(f), { onProgress: (p) => seen.push(p.done) });
    expect(r).toEqual({ files: 4, bytes: 4 + 3 + new TextEncoder().encode("שלום עולם").byteLength + 2, unchanged: 0, trashed: 0 });
    expect(seen.at(-1)).toBe(4);
    expect(getVaultStatus()).toEqual({ location: "folder", name: "My Vault" });
    expect(await bytesAt(f.dir, "img/lumen-asset-1.png")).toEqual([0, 255, 7]);
    expect(await bytesAt(f.dir, "פרויקטים/סיכום.md")).toEqual([...new TextEncoder().encode("שלום עולם")]);
    expect(await bytesAt(f.dir, ".trash/index.json")).toEqual([...new TextEncoder().encode("[]")]);
    // New saves go to the folder; OPFS keeps what it had.
    await writeWorkspaceFile("a.md", "# A, edited\n");
    expect(await bytesAt(f.dir, "a.md")).toEqual([...new TextEncoder().encode("# A, edited\n")]);
    expect(await opfs.readText("a.md")).toBe("# A\n");
    expect(store.get("lumen-vault-location")).toMatchObject({ kind: "folder", name: "My Vault" });
    expect(store.has("lumen-vault-move")).toBe(false);
  });

  it("stops before writing anything when the folder has different files at the same paths", async () => {
    await seed();
    const f = folder();
    await (await f.dir.getFileHandle("a.md", { create: true })).createWritable().then(async (w) => {
      await w.write("someone else's a.md");
      await w.close();
    });
    const err = await moveVault(loc(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultMoveConflictError);
    expect((err as VaultMoveConflictError).paths).toEqual(["a.md"]);
    expect([...f.dir.dirs.keys()]).toEqual([]);
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(await readWorkspaceFile("a.md")).toBe("# A\n");
  });

  it("merges into a folder that already has the same files, without rewriting them", async () => {
    await writeWorkspaceFile("a.md", "same");
    const f = folder();
    await (await f.dir.getFileHandle("a.md", { create: true })).createWritable().then(async (w) => {
      await w.write("same");
      await w.close();
    });
    expect(await moveVault(loc(f))).toMatchObject({ files: 1, unchanged: 1 });
  });

  it("an interrupted move is recorded, nothing switches, and a resume finishes it", async () => {
    await seed();
    const f = folder();
    const plain = f.dir.getDirectoryHandle.bind(f.dir);
    let fail = true;
    // The copy into פרויקטים/ fails the first time, as a full disk would.
    f.dir.getDirectoryHandle = (async (n: string, o?: { create?: boolean }) => {
      if (fail && n === "פרויקטים" && o?.create) throw new DOMException("quota", "QuotaExceededError");
      return plain(n, o);
    }) as typeof f.dir.getDirectoryHandle;
    await expect(moveVault(loc(f))).rejects.toThrow(/quota/);
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(Object.keys(getPendingMove()?.written ?? {}).length).toBeGreaterThan(0);
    // A file the move already wrote and that changed in the source since is
    // the move's own: the resume overwrites it instead of calling it a conflict.
    await writeWorkspaceFile(".trash/index.json", "[1]");
    fail = false;
    const r = await moveVault(loc(f));
    expect(r.files).toBe(4);
    expect(r.unchanged).toBeGreaterThan(0);
    expect(await bytesAt(f.dir, ".trash/index.json")).toEqual([...new TextEncoder().encode("[1]")]);
    expect(getPendingMove()).toBeNull();
    expect(getVaultStatus()).toEqual({ location: "folder", name: "My Vault" });
  });

  it("a resume does not overwrite a copied file that was edited in the folder since", async () => {
    await seed();
    const f = folder();
    const plain = f.dir.getDirectoryHandle.bind(f.dir);
    let fail = true;
    f.dir.getDirectoryHandle = (async (n: string, o?: { create?: boolean }) => {
      if (fail && n === "פרויקטים" && o?.create) throw new DOMException("quota", "QuotaExceededError");
      return plain(n, o);
    }) as typeof f.dir.getDirectoryHandle;
    await expect(moveVault(loc(f))).rejects.toThrow(/quota/);
    // Someone edits the already-copied a.md in the folder before Resume.
    const w = await (await f.dir.getFileHandle("a.md")).createWritable();
    await w.write("edited in the folder");
    await w.close();
    fail = false;
    const err = await moveVault(loc(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultMoveConflictError);
    expect((err as VaultMoveConflictError).paths).toEqual(["a.md"]);
    expect(await bytesAt(f.dir, "a.md")).toEqual([...new TextEncoder().encode("edited in the folder")]);
  });

  it("stops when a target file changes while the copy runs (another app editing the folder)", async () => {
    await seed();
    const f = folder();
    const edit = async () => {
      const w = await (await f.dir.getFileHandle("a.md", { create: true })).createWritable();
      await w.write("written by another app");
      await w.close();
    };
    let edited = false;
    // ".trash/index.json" is copied first; then another app writes a.md.
    const err = await moveVault(loc(f), {
      onProgress: (p) => {
        if (p.done === 1 && !edited) {
          edited = true;
          void edit();
        }
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultMoveConflictError);
    expect(await bytesAt(f.dir, "a.md")).toEqual([...new TextEncoder().encode("written by another app")]);
    expect(getVaultStatus()).toEqual({ location: "opfs" });
  });

  it("a note added to the source during the move stops the switch (resumable)", async () => {
    await seed();
    const f = folder();
    let added = false;
    await expect(
      moveVault(loc(f), {
        onProgress: (p) => {
          if (p.done === 1 && !added) {
            added = true;
            void createOpfsBackend().write("new during move.md", "N");
          }
        },
      }),
    ).rejects.toThrow(/added or removed/);
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(getPendingMove()).not.toBeNull();
    const r = await moveVault(loc(f));
    expect(r.files).toBe(5);
    expect(await bytesAt(f.dir, "new during move.md")).toEqual([78]);
  });

  it("moving back to browser storage replaces the copies the first move left there, and trashes deleted ones", async () => {
    await seed();
    const opfs = createOpfsBackend();
    await moveVault(loc(folder()));
    // In the folder: a.md edited, the Hebrew note deleted.
    await writeWorkspaceFile("a.md", "# A, edited in the folder\n");
    const { deleteWorkspaceFile } = await import("../storage/workspace");
    await deleteWorkspaceFile("פרויקטים/סיכום.md");
    const r = await moveVault({ kind: "opfs" });
    expect(r.trashed).toBe(1);
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(await opfs.readText("a.md")).toBe("# A, edited in the folder\n");
    expect(await opfs.stat("פרויקטים/סיכום.md")).toBeNull();
    const { listTrash } = await import("../storage/trash");
    expect((await listTrash()).map((t) => t.originalPath)).toEqual(["פרויקטים/סיכום.md"]);
  });

  it("a no-copy switch drops an interrupted move (its source is no longer the vault)", async () => {
    store.set("lumen-vault-move", { from: { kind: "opfs" }, to: loc(folder("A")), startedAt: 1, written: { "a.md": "x" }, total: 1 });
    await restoreVaultLocation();
    expect(getPendingMove()).not.toBeNull();
    await openFolderAsVault(folder("B").handle);
    expect(getPendingMove()).toBeNull();
    expect(store.has("lumen-vault-move")).toBe(false);
  });

  it("refuses a folder without permission, before reading anything", async () => {
    await seed();
    const f = folder("Locked", { state: "prompt", onRequest: "denied" });
    await expect(moveVault(loc(f))).rejects.toBeInstanceOf(VaultPermissionError);
    expect(getPendingMove()).toBeNull();
  });

  it("moves back to browser storage the same way, leaving the folder as it was", async () => {
    const f = folder();
    await openFolderAsVault(f.handle);
    await writeWorkspaceFile("only-in-folder.md", "F");
    await moveVault({ kind: "opfs" });
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(await createOpfsBackend().readText("only-in-folder.md")).toBe("F");
    expect(await bytesAt(f.dir, "only-in-folder.md")).toEqual([70]);
  });

  it("cancelling an interrupted move drops the record only", async () => {
    store.set("lumen-vault-move", { from: { kind: "opfs" }, to: { kind: "opfs" }, startedAt: 1, written: {}, total: 1 });
    await restoreVaultLocation();
    expect(getPendingMove()).not.toBeNull();
    await cancelPendingMove();
    expect(getPendingMove()).toBeNull();
    expect(store.has("lumen-vault-move")).toBe(false);
  });
});

describe("start-up and permission", () => {
  it("a slow restore keeps the vault closed (no store at all) until it knows, then opens the right one", async () => {
    const f = folder();
    store.set("lumen-vault-location", loc(f));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __setLocationStore({ ...kv, get: async <T,>(k: string) => (await gate, store.get(k) as T | undefined) });
    const done = restoreVaultLocationWithin(20);
    expect(await done).toEqual({ location: "restoring" });
    expect(isOPFSAvailable()).toBe(false);
    await expect(writeWorkspaceFile("x.md", "x")).rejects.toThrow(/still opening/);
    expect(await createOpfsBackend().stat("x.md")).toBeNull();
    release();
    await vi.waitFor(() => expect(getVaultStatus()).toEqual({ location: "folder", name: "My Vault" }));
    await writeWorkspaceFile("x.md", "x");
    expect(await bytesAt(f.dir, "x.md")).toEqual([120]);
  });

  it("a closed start-up vault becomes OPFS when nothing is stored", async () => {
    setVaultBackend(createMemoryBackend({ id: "restoring" }));
    expect(await restoreVaultLocation()).toEqual({ location: "opfs" });
    expect(getVaultBackend().id).toBe("opfs");
  });

  it("opening another vault without copying detaches the open notes instead of autosaving them over it", async () => {
    const replaced = vi.fn();
    setOnVaultReplaced(replaced);
    await openFolderAsVault(folder().handle);
    expect(replaced).toHaveBeenCalledTimes(1);
    await switchToBrowserStorage();
    expect(replaced).toHaveBeenCalledTimes(2);
    // A move copies the same paths: open notes stay attached.
    await moveVault(loc(folder("Other")));
    expect(replaced).toHaveBeenCalledTimes(2);
  });

  it("detachWorkspaceDocs keeps the text, marks it unsaved and drops the vault path", async () => {
    const { useAppStore } = await import("../store/useStore");
    const { detachWorkspaceDocs } = await import("../store/vaultDocs");
    useAppStore.setState({
      doc: { name: "a.md", content: "A", workspaceName: "a.md", dirty: false },
      openTabs: [
        { id: "a.md", name: "a.md", content: "A", workspaceName: "a.md", dirty: false },
        { id: "scratch", name: "scratch", content: "S", workspaceName: null, dirty: true },
      ],
    } as never);
    detachWorkspaceDocs();
    const st = useAppStore.getState();
    expect(st.doc).toMatchObject({ content: "A", workspaceName: null, dirty: true });
    expect(st.openTabs[0]).toMatchObject({ content: "A", workspaceName: null, dirty: true });
    expect(st.openTabs[1]).toMatchObject({ id: "scratch", workspaceName: null });
  });

  it("detached notes that share a name (or an unsaved tab's) get names of their own; the open note follows its tab", async () => {
    const { useAppStore, tabIdOf } = await import("../store/useStore");
    const { detachWorkspaceDocs } = await import("../store/vaultDocs");
    useAppStore.setState({
      doc: { name: "Clip.md", content: "HE", workspaceName: "he/Clip.md", dirty: false },
      openTabs: [
        { id: "Clip.md", name: "Clip.md", content: "unsaved", workspaceName: null, dirty: true },
        { id: "es/Clip.md", name: "Clip.md", content: "ES", workspaceName: "es/Clip.md", dirty: false },
        { id: "he/Clip.md", name: "Clip.md", content: "HE", workspaceName: "he/Clip.md", dirty: false },
      ],
    } as never);
    detachWorkspaceDocs();
    const st = useAppStore.getState();
    const ids = st.openTabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
    expect(st.openTabs.map((t) => [t.id, t.content])).toEqual([
      ["Clip.md", "unsaved"],
      ["Clip (2).md", "ES"],
      ["Clip (3).md", "HE"],
    ]);
    // The active note is the tab it was: same id, same text.
    expect(tabIdOf(st.doc)).toBe("Clip (3).md");
    expect(st.doc).toMatchObject({ content: "HE", workspaceName: null, dirty: true });
  });

  it("reopens a stored folder when the permission is still granted", async () => {
    const f = folder();
    await (await f.dir.getFileHandle("n.md", { create: true })).createWritable().then(async (w) => {
      await w.write("in the folder");
      await w.close();
    });
    store.set("lumen-vault-location", loc(f));
    expect(await restoreVaultLocation()).toEqual({ location: "folder", name: "My Vault" });
    expect(await readWorkspaceFile("n.md")).toBe("in the folder");
  });

  it("a folder that needs a click is disconnected — no reads, no writes anywhere — until reconnected", async () => {
    const f = folder("My Vault", { state: "prompt", onRequest: "granted" });
    store.set("lumen-vault-location", loc(f));
    expect(await restoreVaultLocation()).toEqual({ location: "folder-disconnected", name: "My Vault" });
    expect(isOPFSAvailable()).toBe(false);
    await expect(writeWorkspaceFile("x.md", "x")).rejects.toThrow(/not connected/);
    expect(await createOpfsBackend().stat("x.md")).toBeNull();
    const changed = vi.fn();
    window.addEventListener("lumen-workspace-changed", changed);
    expect(await reconnectVaultFolder()).toBe(true);
    window.removeEventListener("lumen-workspace-changed", changed);
    expect(changed).toHaveBeenCalled();
    expect(getVaultStatus()).toEqual({ location: "folder", name: "My Vault" });
    await writeWorkspaceFile("x.md", "x");
    expect(await bytesAt(f.dir, "x.md")).toEqual([120]);
  });

  it("a refused reconnect stays disconnected; 'use browser storage' switches to OPFS", async () => {
    const f = folder("My Vault", { state: "prompt", onRequest: "denied" });
    store.set("lumen-vault-location", loc(f));
    await restoreVaultLocation();
    expect(await reconnectVaultFolder()).toBe(false);
    expect(getVaultStatus().location).toBe("folder-disconnected");
    await switchToBrowserStorage();
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(getVaultBackend().id).toBe("opfs");
    expect(store.get("lumen-vault-location")).toEqual({ kind: "opfs" });
  });

  it("knows whether the browser can open folders", () => {
    const w = window as unknown as { showDirectoryPicker?: unknown };
    expect(isFolderVaultSupported()).toBe(false);
    w.showDirectoryPicker = async () => null;
    expect(isFolderVaultSupported()).toBe(true);
    delete w.showDirectoryPicker;
  });
});
