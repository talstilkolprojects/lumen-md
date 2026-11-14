/**
 * Plan 4.3: the desktop vault. The Rust vault commands are faked
 * (helpers/fakeTauriVault.ts — same names, raw bytes, "CODE: message"
 * errors); their file-system semantics are tested by `cargo test` in
 * src-tauri/vault. Here: first run, the one-time migration from the app
 * storage (OPFS) with a backup first, 1,000 notes with Hebrew names and zero
 * lost, resume after an interruption, restore and reconnect, moving back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { fakeTauriVault, type FakeTauriVault } from "./helpers/fakeTauriVault";
import { createOpfsBackend, getVaultBackend } from "../storage/vault";
import {
  __resetVaultLocation,
  __setDesktopInvoke,
  __setLocationStore,
  chooseDesktopVaultFolder,
  getPendingMove,
  getVaultStatus,
  isDesktopFirstRun,
  moveVault,
  openDesktopFolderAsVault,
  reconnectVaultFolder,
  restoreVaultLocation,
  setOnVaultReplaced,
} from "../storage/vault/location";
import { isOPFSAvailable, readWorkspaceFile, writeWorkspaceBlob, writeWorkspaceFile } from "../storage/workspace";

const store = new Map<string, unknown>();
const kv = { get: async <T,>(k: string) => store.get(k) as T | undefined, set: async (k: string, v: unknown) => void store.set(k, v), del: async (k: string) => void store.delete(k) };
let rust: FakeTauriVault;
const bytes = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

beforeEach(() => {
  store.clear();
  __setLocationStore(kv);
  installFakeOpfs();
  __resetVaultLocation();
  rust = fakeTauriVault(null);
  __setDesktopInvoke(rust.invoke);
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  __resetVaultLocation();
});

/** 1,000 notes in Hebrew-named folders, plus an attachment and the trash. */
async function seedThousand() {
  for (let i = 0; i < 1000; i++) {
    await writeWorkspaceFile(`פרויקטים/${i % 10} תיקייה/פתק ${i}.md`, `# פתק ${i}\n\nשלום ${i}\n`);
  }
  await writeWorkspaceBlob("img/lumen-asset-all.bin", new Uint8Array(Array.from({ length: 256 }, (_, i) => i)));
  await writeWorkspaceFile(".trash/index.json", "[]");
}

async function allPaths(b: { list(d: string): Promise<{ kind: string; path: string }[]> }, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await b.list(dir)) out.push(...(e.kind === "directory" ? await allPaths(b, e.path) : [e.path]));
  return out;
}

describe("first run of the desktop app", () => {
  it("asks for the folder; migrates 1,000 notes with Hebrew names — backup first, 0 lost, app storage kept", async () => {
    await seedThousand();
    expect(await restoreVaultLocation()).toEqual({ location: "opfs" });
    expect(isDesktopFirstRun()).toBe(true);

    const r = await chooseDesktopVaultFolder();
    expect(r).toMatchObject({ files: 1002, unchanged: 0 });
    // The backup came first: a zip in the app's data folder.
    expect(r!.backup).toMatch(/^\/appdata\/backups\/vault-backup-.*\.zip$/);
    const zip = [...rust.backups.values()][0];
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(rust.calls.indexOf("vault_backup")).toBeLessThan(rust.calls.indexOf("vault_write"));

    expect(getVaultStatus()).toEqual({ location: "folder", name: "Notes" });
    expect(isDesktopFirstRun()).toBe(false);
    const opfs = createOpfsBackend();
    const src = (await allPaths(opfs)).sort();
    const dst = (await allPaths(rust.fs)).sort();
    expect(dst).toEqual(src);
    expect(dst).toHaveLength(1002);
    for (const p of src) expect(await bytes(await rust.fs.read(p))).toEqual(await bytes(await opfs.read(p)));
    expect(await rust.fs.readText("פרויקטים/7 תיקייה/פתק 997.md")).toBe("# פתק 997\n\nשלום 997\n");

    // Saves now go to the folder; the app storage still has the old copy.
    await writeWorkspaceFile("פרויקטים/7 תיקייה/פתק 997.md", "edited");
    expect(await rust.fs.readText("פרויקטים/7 תיקייה/פתק 997.md")).toBe("edited");
    expect(await opfs.readText("פרויקטים/7 תיקייה/פתק 997.md")).toBe("# פתק 997\n\nשלום 997\n");
    expect(store.get("lumen-vault-location")).toEqual({ kind: "desktop", root: "/home/tal/Notes", name: "Notes" });
    expect(rust.active).toBe("/home/tal/Notes");
  }, 60_000);

  it("an empty app storage just switches to the folder (no backup, no copy)", async () => {
    await restoreVaultLocation();
    const r = await chooseDesktopVaultFolder();
    expect(r).toEqual({ files: 0, bytes: 0, unchanged: 0, trashed: 0, backup: null });
    expect(rust.backups.size).toBe(0);
    expect(getVaultBackend().id).toBe("desktop");
  });

  it("an unreadable app storage stops the migration instead of counting as empty", async () => {
    await writeWorkspaceFile("a.md", "A");
    await restoreVaultLocation();
    const opfs = getVaultBackend();
    const list = opfs.list.bind(opfs);
    opfs.list = async () => {
      throw new Error("I/O error");
    };
    await expect(chooseDesktopVaultFolder()).rejects.toThrow(/I\/O error/);
    opfs.list = list;
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(rust.active).toBeNull();
    expect(await readWorkspaceFile("a.md")).toBe("A");
  });

  it("cancelling the dialog changes nothing", async () => {
    await writeWorkspaceFile("a.md", "A");
    await restoreVaultLocation();
    rust.nextPick = null;
    expect(await chooseDesktopVaultFolder()).toBeNull();
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(isDesktopFirstRun()).toBe(true);
    expect(await readWorkspaceFile("a.md")).toBe("A");
  });

  it("is not asked in a browser", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    await restoreVaultLocation();
    expect(isDesktopFirstRun()).toBe(false);
  });
});

describe("migration safety", () => {
  it("an interrupted migration switches nothing and resumes without losing a note", async () => {
    await seedThousand();
    await restoreVaultLocation();
    const write = rust.fs.write.bind(rust.fs);
    let n = 0;
    rust.fs.write = async (p, d) => {
      if (++n === 500) throw new Error("disk full");
      return write(p, d);
    };
    await expect(chooseDesktopVaultFolder()).rejects.toThrow(/disk full/);
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    const pending = getPendingMove();
    expect(Object.keys(pending!.written)).toHaveLength(499);
    rust.fs.write = write;
    const r = await moveVault(pending!.to);
    expect(r.unchanged).toBe(499);
    expect((await allPaths(rust.fs)).length).toBe(1002);
    expect(getVaultStatus()).toEqual({ location: "folder", name: "Notes" });
  }, 60_000);

  it("moving from one desktop folder to another reads the old one and writes the new one", async () => {
    await writeWorkspaceFile("a.md", "A");
    await restoreVaultLocation();
    await chooseDesktopVaultFolder(); // app storage → /home/tal/Notes
    rust.nextPick = "/media/usb/Vault";
    const r = await chooseDesktopVaultFolder(); // /home/tal/Notes → /media/usb/Vault
    expect(r).toMatchObject({ files: 1 });
    expect(await rust.disk.get("/media/usb/Vault")!.readText("a.md")).toBe("A");
    expect(await rust.fs.readText("a.md")).toBe("A");
    expect(rust.active).toBe("/media/usb/Vault");
    expect(getVaultStatus()).toEqual({ location: "folder", name: "Vault" });
  });

  it("is reversible: moving back to app storage brings the folder's edits", async () => {
    await writeWorkspaceFile("a.md", "A");
    await restoreVaultLocation();
    await chooseDesktopVaultFolder();
    await writeWorkspaceFile("a.md", "A, edited on disk");
    await moveVault({ kind: "opfs" });
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(await readWorkspaceFile("a.md")).toBe("A, edited on disk");
    expect(await rust.fs.readText("a.md")).toBe("A, edited on disk");
    // The app no longer holds the folder.
    expect(rust.active).toBeNull();
    expect(rust.calls).toContain("vault_forget");
  });
});

describe("later launches", () => {
  it("reopens the stored folder when the app still holds it", async () => {
    rust = fakeTauriVault("/home/tal/Notes");
    __setDesktopInvoke(rust.invoke);
    await rust.fs.write("n.md", "on disk");
    store.set("lumen-vault-location", { kind: "desktop", root: "/home/tal/Notes", name: "Notes" });
    expect(await restoreVaultLocation()).toEqual({ location: "folder", name: "Notes" });
    expect(await readWorkspaceFile("n.md")).toBe("on disk");
    expect(isDesktopFirstRun()).toBe(false);
  });

  it("a lost folder is disconnected (no reads or writes anywhere) until the user picks it again", async () => {
    store.set("lumen-vault-location", { kind: "desktop", root: "/home/tal/Notes", name: "Notes" });
    expect(await restoreVaultLocation()).toEqual({ location: "folder-disconnected", name: "Notes" });
    expect(isOPFSAvailable()).toBe(false);
    await expect(writeWorkspaceFile("x.md", "x")).rejects.toThrow();
    expect(await createOpfsBackend().stat("x.md")).toBeNull();
    expect(await reconnectVaultFolder()).toBe(true);
    expect(getVaultStatus()).toEqual({ location: "folder", name: "Notes" });
    await writeWorkspaceFile("x.md", "x");
    expect(await rust.fs.readText("x.md")).toBe("x");
  });

  it("opening another folder without copying detaches the open notes", async () => {
    const replaced = vi.fn();
    setOnVaultReplaced(replaced);
    await restoreVaultLocation();
    rust.nextPick = "C:\\Users\\tal\\Obsidian Vault";
    expect(await openDesktopFolderAsVault()).toBe("Obsidian Vault");
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(getVaultStatus()).toEqual({ location: "folder", name: "Obsidian Vault" });
  });
});
