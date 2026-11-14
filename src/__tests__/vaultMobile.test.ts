/**
 * Plan 4.20: the vault in a folder on the phone. The native APIs are faked
 * (helpers/fakeMobile.ts — the Capacitor Filesystem plugin for the iOS
 * Documents folder and the Android app folder, Lumen's SAF plugin for a
 * folder picked on Android); the VaultBackend contract suite runs on both
 * (vaultBackend.contract.test.ts). Here: choosing the folder (notes copied,
 * app storage kept), restore, a revoked Android permission, an edit made in
 * the Files app reaching Lumen (4.4), and the fallbacks when a plugin is
 * missing. On a device: owner item 15.13 (mobile/README.md).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { fakeBridge } from "./helpers/fakeMobile";
import { createOpfsBackend, getVaultBackend, watchVault, type VaultEvent } from "../storage/vault";
import {
  __resetVaultLocation,
  __setLocationStore,
  __setMobileBridge,
  chooseMobileVaultFolder,
  getVaultStatus,
  moveVault,
  openMobileFolderAsVault,
  reconnectVaultFolder,
  restoreVaultLocation,
} from "../storage/vault/location";
import { capacitorFs, fromBase64, toBase64 } from "../storage/vault/mobile";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";

const store = new Map<string, unknown>();
const kv = { get: async <T,>(k: string) => store.get(k) as T | undefined, set: async (k: string, v: unknown) => void store.set(k, v), del: async (k: string) => void store.delete(k) };

beforeEach(() => {
  store.clear();
  __setLocationStore(kv);
  installFakeOpfs();
  __resetVaultLocation();
});
afterEach(() => {
  __setMobileBridge(null);
  __resetVaultLocation();
});

async function seed() {
  await writeWorkspaceFile("יומן/2026-11-09.md", "# היום\nשלום");
  await writeWorkspaceFile("Projects/Home.md", "- [ ] rent");
}

describe("iOS: the app's Documents folder (Files app)", () => {
  it("moves the notes there — copied and checked, the app storage kept — and opens it again after a restart", async () => {
    const phone = fakeBridge("ios");
    __setMobileBridge(phone.bridge);
    await seed();
    const r = await chooseMobileVaultFolder();
    expect(r).toMatchObject({ files: 2 });
    expect(getVaultStatus()).toEqual({ location: "folder", name: "Lumen" });
    const docs = phone.fs.folder("DOCUMENTS");
    expect(docs.text("יומן/2026-11-09.md")).toBe("# היום\nשלום");
    expect(await createOpfsBackend().readText("Projects/Home.md")).toBe("- [ ] rent");

    __resetVaultLocation();
    __setMobileBridge(phone.bridge);
    expect(await restoreVaultLocation()).toEqual({ location: "folder", name: "Lumen" });
    expect(getVaultBackend().id).toBe("mobile");
    await writeWorkspaceFile("New.md", "from Lumen");
    expect(docs.text("New.md")).toBe("from Lumen");
  });

  it("an edit made in the Files app reaches Lumen when the app comes back to the front (plan 4.4)", async () => {
    const phone = fakeBridge("ios");
    __setMobileBridge(phone.bridge);
    await seed();
    await chooseMobileVaultFolder();
    const events: VaultEvent[] = [];
    const off = watchVault((e) => events.push(e));
    // Let the watcher take its first snapshot.
    await new Promise((r) => setTimeout(r, 30));
    phone.fs.folder("DOCUMENTS").edit("Projects/Home.md", "- [x] rent (edited in Files)");
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => events.some((e) => e.origin === "external" && e.path === "Projects/Home.md"), { timeout: 2000 }).toBe(true);
    expect(await readWorkspaceFile("Projects/Home.md")).toBe("- [x] rent (edited in Files)");
    off();
  });

  it("without @capacitor/filesystem in the build, choosing a phone folder says so and the vault stays where it is", async () => {
    const phone = fakeBridge("ios", { filesystem: false });
    __setMobileBridge(phone.bridge);
    await seed();
    await expect(chooseMobileVaultFolder()).rejects.toMatchObject({ name: "MobileVaultUnavailableError" });
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(await readWorkspaceFile("Projects/Home.md")).toBe("- [ ] rent");
  });
});

describe("Android: a folder picked with the Storage Access Framework", () => {
  it("cancelling the picker changes nothing", async () => {
    const phone = fakeBridge("android");
    __setMobileBridge(phone.bridge);
    phone.saf.nextPick = { uri: null, name: "" };
    await seed();
    expect(await chooseMobileVaultFolder()).toBeNull();
    expect(getVaultStatus()).toEqual({ location: "opfs" });
  });

  it("moves the notes into the picked folder; a revoked permission makes the vault disconnected until it is picked again", async () => {
    const phone = fakeBridge("android");
    __setMobileBridge(phone.bridge);
    await seed();
    const uri = phone.saf.nextPick.uri!;
    expect(await chooseMobileVaultFolder()).toMatchObject({ files: 2 });
    expect(getVaultStatus()).toEqual({ location: "folder", name: "Notes" });
    expect(phone.saf.tree(uri).text("Projects/Home.md")).toBe("- [ ] rent");

    // Revoked in the system settings, then the app restarts.
    phone.saf.granted.delete(uri);
    __resetVaultLocation();
    __setMobileBridge(phone.bridge);
    expect(await restoreVaultLocation()).toEqual({ location: "folder-disconnected", name: "Notes" });
    // Closed: nothing is read or written anywhere else meanwhile.
    expect(getVaultBackend().available()).toBe(false);
    expect(await reconnectVaultFolder()).toBe(true);
    expect(getVaultStatus()).toEqual({ location: "folder", name: "Notes" });
    expect(await readWorkspaceFile("Projects/Home.md")).toBe("- [ ] rent");
  });

  it("opens a folder that already has notes as the vault, without copying", async () => {
    const phone = fakeBridge("android");
    __setMobileBridge(phone.bridge);
    const uri = phone.saf.nextPick.uri!;
    phone.saf.tree(uri).edit("Obsidian note.md", "# from another app");
    await seed();
    expect(await openMobileFolderAsVault()).toBe("Notes");
    expect(await readWorkspaceFile("Obsidian note.md")).toBe("# from another app");
    expect(phone.saf.tree(uri).node("Projects/Home.md")).toBeNull();
  });

  it("without Lumen's folder plugin: the app's own folder", async () => {
    const phone = fakeBridge("android", { folder: false });
    __setMobileBridge(phone.bridge);
    await seed();
    expect(await chooseMobileVaultFolder()).toMatchObject({ files: 2 });
    expect(phone.fs.folder("EXTERNAL").text("Projects/Home.md")).toBe("- [ ] rent");
  });

  it("moves back to the app storage", async () => {
    const phone = fakeBridge("android");
    __setMobileBridge(phone.bridge);
    await seed();
    await chooseMobileVaultFolder();
    await writeWorkspaceFile("Written on the phone.md", "x");
    expect(await moveVault({ kind: "opfs" })).toMatchObject({ files: 3 });
    expect(getVaultStatus()).toEqual({ location: "opfs" });
    expect(await readWorkspaceFile("Written on the phone.md")).toBe("x");
  });
});

describe("the Capacitor Filesystem adapter", () => {
  it("bytes travel as base64 both ways, Hebrew and binary intact", async () => {
    const phone = fakeBridge("ios");
    const fs = capacitorFs(phone.bridge.filesystem!, "DOCUMENTS");
    const bin = new Uint8Array(Array.from({ length: 70_000 }, (_, i) => i % 256));
    await fs.writeFile("a/b.bin", bin);
    expect([...(await fs.readFile("a/b.bin"))]).toEqual([...bin]);
    expect(fromBase64(toBase64(new TextEncoder().encode("שלום")))).toEqual(new TextEncoder().encode("שלום"));
    expect(await fs.stat("missing.md")).toBeNull();
    expect(await fs.stat("a")).toMatchObject({ type: "directory" });
  });
});
