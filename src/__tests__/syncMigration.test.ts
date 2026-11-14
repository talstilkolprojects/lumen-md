/**
 * Plain-text notes an earlier Lumen synced to Dropbox / Google Drive move
 * into the encrypted vault (plan 3.5): imported, backed up at the provider
 * (moved aside, never deleted), revertible, resumable. Against the same
 * mock servers as syncProviders.test.ts — no real Dropbox/Drive until
 * Tal's client ids (plan 15.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropboxLegacy, gdriveLegacy, type LegacyCloudStore } from "../sync/cloud";
import { memoryFiles, type MemoryFiles } from "../sync/e2ee/localFiles";
import {
  __setMigrationStore,
  loadMigrationRecord,
  migratePlaintext,
  planPlaintextMigration,
  revertPlaintextMigration,
} from "../sync/e2ee/providers/migrate";
import { setSecret, __resetSecretStore } from "../lib/secretStore";
import { fakeFetch, text, utf8, type FakeHandler } from "./helpers/fakeServers/http";
import { fakeDropbox } from "./helpers/fakeServers/dropbox";
import { fakeGdrive, type DriveFile } from "./helpers/fakeServers/gdrive";

interface Lab {
  store: LegacyCloudStore;
  label: string;
  /** Plain-text files at the provider, path (relative to the legacy folder) → text. */
  plain(): Map<string, string>;
  /** Every file the provider holds, wherever it is. */
  count(): number;
  /** From now on, fail the n-th move request with a 503. */
  failMove(n: number): void;
  heal(): void;
}

const kv = new Map<string, unknown>();
const memKv = {
  get: async <T,>(k: string) => kv.get(k) as T | undefined,
  set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
  del: async (k: string) => void kv.delete(k),
};

function gate(handle: FakeHandler, isMove: (method: string, url: URL) => boolean) {
  let failAt = 0;
  let moves = 0;
  let broken = false;
  const handler: FakeHandler = (req) => {
    if (isMove(req.method, req.url) && failAt && ++moves >= failAt) broken = true;
    if (broken) return { status: 503, body: "down" };
    return handle(req);
  };
  return { handler, failMove: (n: number) => ((failAt = n), (moves = 0)), heal: () => ((broken = false), (failAt = 0)) };
}

const labs: Array<[string, (seed: Record<string, string>) => Promise<Lab>]> = [
  [
    "dropbox",
    async (seed) => {
      const server = fakeDropbox({ token: "t" });
      await setSecret("lumen.cloud.dropbox.token", JSON.stringify({ access: "t", expiresAt: Date.now() + 3_600_000 }));
      for (const [p, t] of Object.entries(seed)) {
        const display = `/Apps/Lumen/${p}`;
        server.files.set(display.toLowerCase(), { data: text(t), rev: "r1", display });
      }
      // The encrypted vault shares the app folder: never migrated.
      server.files.set("/apps/lumen/vault/lumen-e2ee-vault", { data: text("ciphertext"), rev: "r1", display: "/Apps/Lumen/vault/lumen-e2ee-vault" });
      const g = gate(server.handle, (_m, u) => u.pathname === "/2/files/move_v2");
      vi.stubGlobal("fetch", fakeFetch(g.handler));
      return {
        store: dropboxLegacy,
        label: "from Dropbox",
        plain: () =>
          new Map(
            [...server.files.values()]
              .filter((e) => e.display.startsWith("/Apps/Lumen/") && !e.display.startsWith("/Apps/Lumen/vault/"))
              .map((e) => [e.display.slice("/Apps/Lumen/".length), utf8(e.data)]),
          ),
        count: () => server.files.size,
        failMove: g.failMove,
        heal: g.heal,
      };
    },
  ],
  [
    "gdrive",
    async (seed) => {
      const server = fakeGdrive({ token: "t" });
      await setSecret("lumen.cloud.gdrive.token", JSON.stringify({ access: "t", expiresAt: Date.now() + 3_600_000 }));
      const FOLDER = "application/vnd.google-apps.folder";
      let n = 0;
      const add = (f: Partial<DriveFile> & { name: string; parents: string[] }, data = new Uint8Array()) => {
        const id = `seed${++n}`;
        server.files.set(id, { id, mimeType: "text/markdown", data, etag: `"s${n}"`, trashed: false, ...f });
        return id;
      };
      const root = add({ name: "Lumen", parents: ["root"], mimeType: FOLDER, appProperties: { lumen: "true" } });
      for (const [p, t] of Object.entries(seed)) add({ name: p, parents: [root] }, text(t));
      const g = gate(server.handle, (m, u) => m === "PATCH" && u.searchParams.has("addParents"));
      vi.stubGlobal("fetch", fakeFetch(g.handler));
      return {
        store: gdriveLegacy,
        label: "from Google Drive",
        plain: () =>
          new Map(
            [...server.files.values()]
              .filter((f) => f.parents.includes(root) && f.mimeType !== FOLDER)
              .map((f) => [f.name, utf8(f.data)]),
          ),
        count: () => [...server.files.values()].filter((f) => f.mimeType !== FOLDER).length,
        failMove: g.failMove,
        heal: g.heal,
      };
    },
  ],
];

beforeEach(() => {
  kv.clear();
  __setMigrationStore(memKv);
});
afterEach(() => {
  __setMigrationStore(null);
  __resetSecretStore();
  vi.unstubAllGlobals();
});

const write = (local: MemoryFiles, p: string, t: string) => local.write(p, text(t), null);

describe.each(labs)("plain-text migration: %s", (_name, make) => {
  const seed = { "a.md": "alpha", "b.md": "provider b", "c.md": "same", "d.md": "delta" };

  it("plans: lists the plain-text files and which ones clash with the vault", async () => {
    const lab = await make(seed);
    const local = memoryFiles();
    await write(local, "b.md", "local b");
    await write(local, "c.md", "same");
    const plan = await planPlaintextMigration(lab.store, local);
    expect(plan.files.map((f) => f.path).sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(plan.clashes).toEqual(["b.md"]);
  });

  it("imports every note, keeps both sides of a clash, and backs the files up instead of deleting them", async () => {
    const lab = await make(seed);
    const local = memoryFiles();
    await write(local, "b.md", "local b");
    await write(local, "c.md", "same");
    const before = lab.count();
    const progress: number[] = [];
    const record = await migratePlaintext(lab.store, local, { now: () => Date.UTC(2026, 9, 24, 12), onProgress: (d) => progress.push(d) });

    expect(local.text("a.md")).toBe("alpha");
    expect(local.text("b.md")).toBe("local b"); // never overwritten
    expect(local.text(`b (${lab.label}).md`)).toBe("provider b");
    expect(local.text("c.md")).toBe("same");
    expect([...local.files.keys()].filter((p) => p.startsWith("c ("))).toEqual([]); // identical: no copy
    expect(local.text("d.md")).toBe("delta");
    expect(progress).toEqual([1, 2, 3, 4]);

    // Nothing deleted at the provider: the same number of files, all inside the backup folder.
    expect(lab.count()).toBe(before);
    const plain = lab.plain();
    expect([...plain.keys()].filter((p) => !p.startsWith(record.backupFolder + "/"))).toEqual([]);
    expect(record.backupFolder).toBe("lumen-plaintext-backup-2026-10-24-12-00-00");
    expect(record.finishedAt).not.toBeNull();
    expect((await loadMigrationRecord(lab.store.name))?.moved).toHaveLength(4);
    // A second run finds nothing left to move.
    expect((await planPlaintextMigration(lab.store, local)).files).toEqual([]);
  });

  it("reverts: the files move back to where they were, the vault keeps its copies", async () => {
    const lab = await make(seed);
    const local = memoryFiles();
    await migratePlaintext(lab.store, local);
    expect(await revertPlaintextMigration(lab.store)).toBe(4);
    expect(Object.fromEntries([...lab.plain()].filter(([p]) => !p.includes("/")))).toEqual(seed);
    expect(local.text("a.md")).toBe("alpha");
    expect(await loadMigrationRecord(lab.store.name)).toBeNull();
  });

  it("resumes after the provider drops mid-run, without importing anything twice", async () => {
    const lab = await make(seed);
    const local = memoryFiles();
    await write(local, "b.md", "local b");
    lab.failMove(3);
    await expect(migratePlaintext(lab.store, local)).rejects.toThrow();
    const half = await loadMigrationRecord(lab.store.name);
    expect(half?.finishedAt).toBeNull();
    expect(half?.moved).toHaveLength(2);
    lab.heal();
    const done = await migratePlaintext(lab.store, local);
    expect(done.backupFolder).toBe(half?.backupFolder); // same run, same backup folder
    expect(done.moved).toHaveLength(4);
    expect([...local.files.keys()].sort()).toEqual(["a.md", "b.md", `b (${lab.label}).md`, "c.md", "d.md"].sort());
    expect(await revertPlaintextMigration(lab.store)).toBe(4);
  });
});

it("dropbox: the encrypted vault folder is not plain text and is never listed for migration", async () => {
  const lab = await labs[0][1]({ "a.md": "alpha" });
  expect((await lab.store.listFiles()).map((f) => f.path)).toEqual(["a.md"]);
});
