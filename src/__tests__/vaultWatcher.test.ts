/**
 * Plan 4.4: noticing changes made outside Lumen. Snapshot diffs, the polling
 * watcher on a folder (a fake picked folder written "by another program"
 * straight through its handles), own writes not reported, and the desktop
 * watcher (Rust `vault_snapshot`, faked) reporting an external edit within 2 s.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDir, installFakeOpfs } from "./helpers/fakeOpfs";
import { fakeTauriVault } from "./helpers/fakeTauriVault";
import { createDirectoryHandleBackend, watchVault, type VaultEvent } from "../storage/vault";
import { diffSnapshots, watchExternalChanges, type Snapshot } from "../storage/vault/watcher";
import { __resetVaultLocation, __setDesktopInvoke, __setLocationStore, restoreVaultLocation } from "../storage/vault/location";

const snap = (o: Record<string, [number, number]>): Snapshot => new Map(Object.entries(o).map(([p, [size, mtime]]) => [p, { size, mtime }]));

describe("diffSnapshots", () => {
  it("reports changed, new and vanished files", () => {
    expect(diffSnapshots(snap({ "a.md": [1, 10], "b.md": [2, 20] }), snap({ "a.md": [1, 11], "c.md": [9, 30] }))).toEqual([
      { type: "write", path: "a.md" },
      { type: "delete", path: "b.md" },
      { type: "write", path: "c.md" },
    ]);
  });

  it("pairs a vanished and a new file with the same size and mtime as a rename (Hebrew names too)", () => {
    expect(diffSnapshots(snap({ "פתק.md": [5, 100] }), snap({ "ארכיון/פתק.md": [5, 100] }))).toEqual([
      { type: "rename", from: "פתק.md", path: "ארכיון/פתק.md" },
    ]);
  });

  it("an ambiguous pair is a delete plus writes, never a guessed rename", () => {
    expect(diffSnapshots(snap({ "a.md": [5, 100] }), snap({ "x.md": [5, 100], "y.md": [5, 100] }))).toEqual([
      { type: "delete", path: "a.md" },
      { type: "write", path: "x.md" },
      { type: "write", path: "y.md" },
    ]);
  });

  it("two vanished files with the same size and mtime and one new file are deletes and a write", () => {
    expect(diffSnapshots(snap({ "a.md": [5, 100], "b.md": [5, 100] }), snap({ "c.md": [5, 100] }))).toEqual([
      { type: "delete", path: "a.md" },
      { type: "delete", path: "b.md" },
      { type: "write", path: "c.md" },
    ]);
  });

  it("nothing changed, nothing reported", () => {
    expect(diffSnapshots(snap({ "a.md": [1, 1] }), snap({ "a.md": [1, 1] }))).toEqual([]);
  });
});

/** "Another program": writes the fake folder through its handles, not through Lumen. */
async function writeOutside(dir: FakeDir, path: string, text: string) {
  const parts = path.split("/");
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(text);
  await w.close();
}

const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return Date.now() - t0;
};

describe("the folder watcher", () => {
  let dir: FakeDir;
  let stop: (() => void) | null = null;
  beforeEach(() => {
    dir = new FakeDir("My Vault");
  });
  afterEach(() => stop?.());

  it("reports edits, new files, renames and deletes made by another program; not Lumen's own writes", async () => {
    const backend = createDirectoryHandleBackend({ id: "folder", root: async () => dir as unknown as FileSystemDirectoryHandle });
    await backend.write("a.md", "one");
    await backend.write("b.md", "bee");
    const got: VaultEvent[] = [];
    backend.watch((e) => got.push(e));
    stop = watchExternalChanges(backend, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 80)); // baseline

    await backend.write("a.md", "one, by Lumen"); // own write: not external
    await new Promise((r) => setTimeout(r, 150));
    expect(got.filter((e) => e.origin === "external")).toEqual([]);

    await new Promise((r) => setTimeout(r, 5)); // a later mtime
    await writeOutside(dir, "a.md", "one, edited in another editor");
    await writeOutside(dir, "notes/new.md", "new");
    await dir.removeEntry("b.md");
    await until(() => got.filter((e) => e.origin === "external").length >= 3, 2000);
    expect(got.filter((e) => e.origin === "external").map(({ type, path }) => ({ type, path }))).toEqual(
      expect.arrayContaining([
        { type: "write", path: "a.md" },
        { type: "write", path: "notes/new.md" },
        { type: "delete", path: "b.md" },
      ]),
    );
  });
});

describe("own writes and external writes to the same path", () => {
  it("an edit by another program right after Lumen's own write is still reported", async () => {
    const dir = new FakeDir("V");
    const backend = createDirectoryHandleBackend({ id: "folder", root: async () => dir as unknown as FileSystemDirectoryHandle });
    await backend.write("a.md", "one");
    const got: VaultEvent[] = [];
    backend.watch((e) => got.push(e));
    const stop = watchExternalChanges(backend, { intervalMs: 300 });
    try {
      await new Promise((r) => setTimeout(r, 350)); // baseline
      await backend.write("a.md", "two, by Lumen");
      await new Promise((r) => setTimeout(r, 30));
      await writeOutside(dir, "a.md", "three — another program, same poll window");
      await until(() => got.some((e) => e.origin === "external" && e.path === "a.md"), 2000);
    } finally {
      stop();
    }
  });
});

describe("the desktop watcher", () => {
  beforeEach(() => {
    const store = new Map<string, unknown>([["lumen-vault-location", { kind: "desktop", root: "/home/tal/Notes", name: "Notes" }]]);
    __setLocationStore({ get: async <T,>(k: string) => store.get(k) as T | undefined, set: async (k, v) => void store.set(k, v), del: async (k) => void store.delete(k) });
    installFakeOpfs();
    __resetVaultLocation();
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    __resetVaultLocation();
  });

  it("an edit made on disk by another program reaches Lumen within 2 s", async () => {
    const rust = fakeTauriVault("/home/tal/Notes");
    __setDesktopInvoke(rust.invoke);
    await rust.fs.write("a.md", "one");
    expect(await restoreVaultLocation()).toEqual({ location: "folder", name: "Notes" });
    const got: VaultEvent[] = [];
    const off = watchVault((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 1100)); // first snapshot = baseline
    const t0 = Date.now();
    await rust.fs.write("a.md", "one, edited in Obsidian"); // straight on "disk"
    await until(() => got.some((e) => e.origin === "external" && e.path === "a.md"), 2000);
    expect(Date.now() - t0).toBeLessThan(2000);
    off();
  }, 10_000);
});
