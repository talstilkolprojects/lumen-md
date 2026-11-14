/**
 * Plan W1.6: scheduled backups to a second drive, and the restore drill.
 * The vault and the "second drive" are two memory backends (the same
 * VaultBackend contract as OPFS, a picked folder or the desktop).
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend } from "../storage/vault/memory";
import type { VaultBackend } from "../storage/vault/types";
import { archiveName, archiveTime, BACKUP_DIR, backendTarget, BackupError, listBackups, openBackup, pathInsideVault, providerTarget, restore, runBackup, sha256, skipPath, targetInsideVault, type BackupTarget } from "../backup/backup";
import { selectKept } from "../backup/rotation";
import { readTar, writeTar } from "../backup/tar";
import { startBackupScheduler, TICK_MS } from "../backup/scheduler";
import { __resetBackupStatus, backupHealth, backupStatus, STALE_AFTER_MS } from "../backup/status";
import { generateIdentity } from "../sync/e2ee/age";
import { memoryProvider } from "../sync/e2ee/provider";

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
  __resetBackupStatus();
});

async function allFiles(b: VaultBackend, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await b.list(dir)) out.push(...(e.kind === "directory" ? await allFiles(b, e.path) : [e.path]));
  return out;
}
async function hashes(b: VaultBackend, prefix = ""): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const p of await allFiles(b, prefix)) m.set(p.slice(prefix ? prefix.length + 1 : 0), await sha256(new Uint8Array(await (await b.read(p)).arrayBuffer())));
  return m;
}

/** 1,000 notes and 200 attachments (binary), in nested folders, Hebrew names included. */
async function bigVault(): Promise<VaultBackend> {
  const v = createMemoryBackend({ id: "vault" });
  for (let i = 0; i < 1000; i++) await v.write(`notes/${i % 20}/${i % 3 === 0 ? "פתק" : "note"}-${i}.md`, `# ${i}\n\nשלום ${"x".repeat(i % 97)}\n`);
  for (let i = 0; i < 200; i++) {
    const data = new Uint8Array(2000 + ((i * 37) % 5000));
    for (let k = 0; k < data.length; k++) data[k] = (k * 31 + i * 7) & 255;
    await v.write(`attachments/${i % 5}/img-${i}.png`, data);
  }
  await v.write(".trash/old.md", "in the trash");
  return v;
}

describe("the restore drill (acceptance 1)", () => {
  for (const encrypted of [false, true]) {
    it(`back up 1,000 notes + 200 attachments, delete the vault, restore: 100% identical (${encrypted ? "age" : "plain tar"})`, async () => {
      const vault = await bigVault();
      const drive = createMemoryBackend({ id: "drive" });
      const target = backendTarget(drive, "USB drive");
      const key = await generateIdentity();
      const before = await hashes(vault);
      before.delete(".trash/old.md");
      expect(before.size).toBe(1200);

      const r = await runBackup({ vault, target, mode: encrypted ? { kind: "age", recipient: key.recipient } : { kind: "plain" } });
      expect(r.files).toBe(1200);
      expect(r.name.endsWith(encrypted ? ".tar.age" : ".tar")).toBe(true);

      // The vault is lost.
      for (const e of await vault.list("")) await vault.remove(e.path);
      expect(await allFiles(vault)).toEqual([]);

      // Restore everything into a new folder, and into the empty vault.
      const fresh = createMemoryBackend({ id: "new-folder" });
      const out = await restore({ target, name: r.name, identity: encrypted ? key.identity : undefined, into: fresh, select: { all: true } });
      expect(out.restored).toHaveLength(1200);
      const after = await hashes(fresh);
      let same = 0;
      for (const [p, h] of before) if (after.get(p) === h) same++;
      expect(same).toBe(1200);
      expect(after.size).toBe(1200);
      await restore({ target, name: r.name, identity: encrypted ? key.identity : undefined, into: vault, select: { all: true } });
      expect(await hashes(vault)).toEqual(before);
    }, 300_000);
  }

  it("restores a single file and a folder, never overwriting what is there", async () => {
    const vault = createMemoryBackend();
    await vault.write("a/one.md", "one");
    await vault.write("a/b/two.md", "two");
    await vault.write("c.md", "c");
    const target = backendTarget(createMemoryBackend(), "drive");
    const { name } = await runBackup({ vault, target, mode: { kind: "plain" }, now: () => Date.UTC(2026, 10, 10, 9) });
    await vault.write("a/one.md", "edited since");
    const r = await restore({ target, name, into: vault, select: { file: "a/one.md" }, now: () => Date.UTC(2026, 10, 10, 12) });
    expect(r.renamed).toEqual([["a/one.md", "a/one (restored 2026-11-10).md"]]);
    expect(await vault.readText("a/one.md")).toBe("edited since");
    expect(await vault.readText("a/one (restored 2026-11-10).md")).toBe("one");
    await vault.remove("a/b");
    expect((await restore({ target, name, into: vault, select: { folder: "a/b" } })).restored).toEqual(["a/b/two.md"]);
    await expect(restore({ target, name, into: vault, select: { file: "nope.md" } })).rejects.toBeInstanceOf(BackupError);
  });

  it("refuses a damaged archive, and an encrypted one without the key", async () => {
    const vault = createMemoryBackend();
    await vault.write("a.md", "hello hello hello");
    const drive = createMemoryBackend();
    const target = backendTarget(drive, "drive");
    const { name } = await runBackup({ vault, target, mode: { kind: "plain" } });
    const bytes = await target.read(name);
    const entries = readTar(bytes);
    entries[1].data[0] ^= 1;
    await drive.write(`${BACKUP_DIR}/${name}`, writeTar(entries));
    await expect(openBackup(target, name)).rejects.toThrow(/damaged/);
    const key = await generateIdentity();
    const enc = await runBackup({ vault, target, mode: { kind: "age", recipient: key.recipient }, now: () => Date.now() + 5000 });
    await expect(openBackup(target, enc.name)).rejects.toThrow(/key/);
  });

  it("works over a storage provider too (WebDAV, S3…), and the archive is a standard tar", async () => {
    const vault = createMemoryBackend();
    await vault.write("שלום/עולם.md", "עברית");
    const target = providerTarget(memoryProvider(), "WebDAV");
    const { name } = await runBackup({ vault, target, mode: { kind: "plain" } });
    const entries = readTar(await target.read(name));
    expect(entries.map((e) => e.path)).toEqual([".lumen-backup.json", "שלום/עולם.md"]);
  });
});

describe("a failed backup shows within a minute (acceptance 2)", () => {
  function clock(start: number) {
    let t = start;
    const timers: Array<() => void> = [];
    return {
      now: () => t,
      setInterval: (fn: () => void) => (timers.push(fn), timers.length),
      clearInterval: () => undefined,
      /** Advance by one scheduler tick and run it. */
      async tick() {
        t += TICK_MS;
        for (const f of timers) f();
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }
  const broken: BackupTarget = { id: "broken", label: "unplugged drive", list: async () => [], read: async () => new Uint8Array(), write: async () => Promise.reject(new Error("The drive is not connected")), remove: async () => undefined };

  it("a drive that fails is reported at the next tick (≤ 30 s) after backups are set up", async () => {
    const c = clock(Date.UTC(2026, 10, 10, 8));
    let configured: { target: BackupTarget; mode: { kind: "plain" } } | null = null;
    const notices: Array<[string, string]> = [];
    const s = startBackupScheduler({ config: async () => configured, vault: () => createMemoryBackend(), now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval, notify: (k, d) => notices.push([k, d]) });
    await s.started;
    expect(backupHealth(backupStatus(), c.now())).toBe("never");
    const setUpAt = c.now() + 5000;
    configured = { target: broken, mode: { kind: "plain" } };
    let waited = 0;
    while (backupHealth(backupStatus(), c.now()) !== "failed" && waited < 60_000) {
      await c.tick();
      waited += TICK_MS;
    }
    expect(backupHealth(backupStatus(), c.now())).toBe("failed");
    expect(backupStatus().lastError).toBe("The drive is not connected");
    expect(backupStatus().lastFailureAt! - setUpAt).toBeLessThan(60_000);
    expect(notices).toEqual([["failed", "The drive is not connected"]]);
    s.stop();
  });

  it("three days without a successful backup is said, once a day", async () => {
    const c = clock(Date.UTC(2026, 10, 10, 8));
    const vault = createMemoryBackend();
    await vault.write("a.md", "a");
    let target: BackupTarget = backendTarget(createMemoryBackend(), "drive");
    const notices: string[] = [];
    const s = startBackupScheduler({ config: async () => ({ target, mode: { kind: "plain" } }), vault: () => vault, now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval, notify: (k) => notices.push(k) });
    await s.started;
    expect(notices).toEqual(["done"]);
    target = broken;
    for (let i = 0; i < Math.ceil((STALE_AFTER_MS + 3600_000) / TICK_MS); i++) await c.tick();
    expect(notices.filter((n) => n === "stale")).toHaveLength(1);
    expect(backupHealth(backupStatus(), c.now())).toBe("failed");
    s.stop();
  }, 120_000);
});

describe("never inside the vault (acceptance 3)", () => {
  it("a backup writes nothing into the vault, and leaves the trash and git out", async () => {
    const vault = createMemoryBackend();
    await vault.write("a.md", "a");
    await vault.write(".git/HEAD", "ref: refs/heads/main");
    const writes: string[] = [];
    vault.watch((e) => writes.push(`${e.type} ${e.path}`));
    const drive = createMemoryBackend();
    const { name } = await runBackup({ vault, target: backendTarget(drive, "drive"), mode: { kind: "plain" } });
    expect(writes).toEqual([]);
    expect(await allFiles(vault)).toEqual([".git/HEAD", "a.md"]);
    expect(await allFiles(drive)).toEqual([`${BACKUP_DIR}/${name}`]);
    expect((await openBackup(backendTarget(drive, "drive"), name)).manifest.files.map((f) => f.path)).toEqual(["a.md"]);
    expect([".git", ".git/x", ".trash/a", "a/.git/b"].map(skipPath)).toEqual([true, true, true, false]);
  });

  it("refuses a target folder that is the vault or inside it", async () => {
    const handle = (id: string, inside: string[] = []) => ({ id, isSameEntry: async (o: { id: string }) => o.id === id, resolve: async (o: { id: string }) => (inside.includes(o.id) ? ["x"] : null) }) as unknown as FileSystemDirectoryHandle;
    const vaultRoot = handle("vault", ["vault/backups"]);
    expect(await targetInsideVault(vaultRoot, handle("vault"))).toBe(true);
    expect(await targetInsideVault(vaultRoot, handle("vault/backups"))).toBe(true);
    expect(await targetInsideVault(vaultRoot, handle("usb"))).toBe(false);
    expect(await targetInsideVault(null, handle("usb"))).toBe(false);
    expect(pathInsideVault("/Users/tal/Notes", "/Users/tal/Notes/backups")).toBe(true);
    expect(pathInsideVault("C:\\Notes", "c:/notes")).toBe(true);
    expect(pathInsideVault("/Users/tal/Notes", "/Volumes/USB/Lumen")).toBe(false);
    expect(pathInsideVault("/Users/tal/Notes", "/Users/tal/Notes2")).toBe(false);
  });
});

describe("rotation", () => {
  it("keeps 7 daily, 4 weekly and 6 monthly backups, the newest always", async () => {
    const day = 86_400_000;
    const start = Date.UTC(2025, 0, 1, 10);
    const snaps = Array.from({ length: 400 }, (_, i) => ({ name: `s${i}`, at: start + i * day }));
    const { keep, why } = selectKept(snaps);
    const newest = snaps[399];
    expect(keep[0]).toEqual(newest);
    expect([...why.values()].filter((w) => w.includes("daily"))).toHaveLength(7);
    expect([...why.values()].filter((w) => w.includes("weekly"))).toHaveLength(4);
    expect([...why.values()].filter((w) => w.includes("monthly"))).toHaveLength(6);
    expect(keep.length).toBeLessThanOrEqual(17);
    expect(keep.length).toBeGreaterThanOrEqual(13);
    // Several a day: only the newest of each day counts.
    const busy = [0, 1, 2].map((h) => ({ name: `h${h}`, at: start + h * 3600_000 }));
    expect(selectKept(busy).keep.map((s) => s.name)).toEqual(["h2"]);
  });

  it("prunes on the target after each backup, and names archives by UTC time", async () => {
    const vault = createMemoryBackend();
    await vault.write("a.md", "a");
    const target = backendTarget(createMemoryBackend(), "drive");
    const start = Date.UTC(2026, 0, 1, 3);
    for (let i = 0; i < 40; i++) await runBackup({ vault, target, mode: { kind: "plain" }, now: () => start + i * 86_400_000 });
    const list = await listBackups(target);
    expect(list.length).toBeLessThanOrEqual(17);
    expect(list[0].name).toBe(archiveName(start + 39 * 86_400_000, false));
    expect(archiveTime(archiveName(start, true))).toBe(start);
  });
});
