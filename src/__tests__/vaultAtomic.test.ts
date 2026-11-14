/**
 * Atomic saves (plan W1.5, src/storage/vault/atomic.ts): a save that is
 * stopped anywhere leaves every note in its old version or its new one,
 * whole — never cut short, never missing.
 *
 * The crash here is simulated: the file system "dies" before a chosen step
 * (or half way through writing the bytes), the app "restarts", and the
 * recovery runs. scripts/vault-crash-test.mjs does the same with a real
 * process killed with SIGKILL on a real disk (see the last test).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { atomicWrite, isTempName, oldNameFor, parseLeftover, recoverDir, tempNameFor, type AtomicFs } from "../storage/vault/atomic";
import { createDirectoryHandleBackend } from "../storage/vault";
import { capacitorFs, createMobileBackend, safFs } from "../storage/vault/mobile";
import { fakeCapacitorFilesystem, fakeSafPlugin } from "./helpers/fakeMobile";
import { FakeDir } from "./helpers/fakeOpfs";

class Crash extends Error {}

/** A flat in-memory folder that stops working at step `crashAt` (and may cut that write short). */
class CrashFs implements AtomicFs {
  files = new Map<string, Uint8Array>();
  steps = 0;
  crashAt = Infinity;
  /** 0–1: how much of the write that crashes lands (a torn write). */
  tear = 0;

  private step(): void {
    if (this.steps++ >= this.crashAt) throw new Crash("crash");
  }
  async readdir(dir: string) {
    const pre = dir ? dir + "/" : "";
    return [...this.files.keys()].filter((p) => p.startsWith(pre) && !p.slice(pre.length).includes("/")).map((p) => ({ name: p.slice(pre.length), type: "file" as const }));
  }
  async exists(path: string) {
    this.step();
    return this.files.has(path);
  }
  async writeFile(path: string, data: Uint8Array) {
    if (this.steps >= this.crashAt) {
      // The process dies half way through writing.
      this.files.set(path, data.slice(0, Math.floor(data.byteLength * this.tear)));
    }
    this.step();
    this.files.set(path, data.slice());
  }
  async size(path: string) {
    this.step();
    return this.files.get(path)?.byteLength ?? null;
  }
  async rename(from: string, to: string) {
    this.step();
    const d = this.files.get(from);
    if (!d) throw new Error(`missing ${from}`);
    if (this.files.has(to)) throw new Error(`exists ${to}`);
    this.files.delete(from);
    this.files.set(to, d);
  }
  async remove(path: string) {
    this.step();
    if (!this.files.delete(path)) throw new Error(`missing ${path}`);
  }
  restart(): void {
    this.steps = 0;
    this.crashAt = Infinity;
  }
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

describe("atomic saves: names", () => {
  it("names the temporary and old files after the note and the save", () => {
    expect(parseLeftover(tempNameFor("שלום~a.md", "k1"))).toEqual({ kind: "tmp", target: "שלום~a.md", id: "k1" });
    expect(parseLeftover(oldNameFor("a.md", "k2"))).toEqual({ kind: "old", target: "a.md", id: "k2" });
    expect(parseLeftover("a.md")).toBeNull();
    expect(parseLeftover(".lumen-tmp~")).toBeNull();
    for (const n of [".lumen-tmp~a.md~x", ".lumen-old~a.md~x", ".lumen-tmp-123-4", ".lumen-rename-abc123", "note.md.crswap"]) expect(isTempName(n), n).toBe(true);
    for (const n of ["a.md", ".lumen-tmp", ".trash", "crswap.md"]) expect(isTempName(n), n).toBe(false);
  });
});

describe("atomic saves: a crash at any step", () => {
  it("1,000 random saves, each stopped at a random step: every note is old or new, whole, and no leftovers stay", async () => {
    const random = rng(4_20_26);
    const fs = new CrashFs();
    const names = Array.from({ length: 20 }, (_, i) => (i % 3 ? `dir/n${i}.md` : `n${i}.md`));
    const current = new Map<string, string>();
    let crashed = 0;
    let landed = 0;
    for (let i = 0; i < 1000; i++) {
      const path = names[Math.floor(random() * names.length)];
      const before = current.get(path);
      const next = `v${i} ` + "שלום עולם ".repeat(1 + Math.floor(random() * 200));
      fs.crashAt = random() < 0.85 ? Math.floor(random() * 7) : Infinity;
      fs.tear = random();
      let ok = false;
      try {
        await atomicWrite(fs, path, enc(next));
        ok = true;
      } catch (e) {
        if (!(e instanceof Crash)) throw e;
        crashed++;
      }
      fs.restart();
      for (const dir of ["", "dir"]) await recoverDir(fs, dir);
      const after = dec(fs.files.get(path));
      if (ok) expect(after).toBe(next);
      else expect(after === before || after === next, `save ${i} of ${path}: ${after?.slice(0, 20)}`).toBe(true);
      if (after === next) landed++;
      if (after === undefined) current.delete(path);
      else current.set(path, after);
      // No other note changed, and nothing is left behind.
      for (const [p, text] of current) expect(dec(fs.files.get(p))).toBe(text);
      expect([...fs.files.keys()].filter((p) => isTempName(p.split("/").pop()!))).toEqual([]);
    }
    expect(crashed).toBeGreaterThan(700);
    expect(landed).toBeGreaterThan(150);
  });

  it("recovery: promotes a complete new version, restores the old one, cleans up after a finished save", async () => {
    const fs = new CrashFs();
    // Stopped between steps 2 and 3: note missing, old + complete temp there.
    fs.files.set(oldNameFor("a.md", "s1"), enc("old a"));
    fs.files.set(tempNameFor("a.md", "s1"), enc("new a"));
    // Old only (the temporary file is gone): the old version comes back.
    fs.files.set(oldNameFor("b.md", "s2"), enc("old b"));
    // Stopped after step 3: the note is new; the old file goes.
    fs.files.set("c.md", enc("new c"));
    fs.files.set(oldNameFor("c.md", "s3"), enc("old c"));
    // Stopped during step 1: the note is old; the torn temp goes.
    fs.files.set("d.md", enc("old d"));
    fs.files.set(tempNameFor("d.md", "s4"), enc("ne"));
    const done = await recoverDir(fs, "");
    expect(done.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "a.md", action: "promoted" },
      { path: "b.md", action: "restored" },
      { path: "c.md", action: "cleaned" },
      { path: "d.md", action: "cleaned" },
    ]);
    expect([...fs.files.keys()].sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect([dec(fs.files.get("a.md")), dec(fs.files.get("b.md")), dec(fs.files.get("c.md")), dec(fs.files.get("d.md"))]).toEqual(["new a", "old b", "new c", "old d"]);
  });

  it("a write the platform cut short never replaces the note", async () => {
    const fs = new CrashFs();
    fs.files.set("a.md", enc("good"));
    const short: AtomicFs = {
      readdir: (d) => fs.readdir(d),
      exists: (p) => fs.exists(p),
      rename: (a, b) => fs.rename(a, b),
      remove: (p) => fs.remove(p),
      size: (p) => fs.size(p),
      writeFile: async (p, d) => void fs.files.set(p, d.slice(0, 2)),
    };
    await expect(atomicWrite(short, "a.md", enc("better"))).rejects.toThrow(/cut short/);
    expect([...fs.files.keys()]).toEqual(["a.md"]);
    expect(dec(fs.files.get("a.md"))).toBe("good");
  });

  it("leaves the files of a save still running alone", async () => {
    const fs = new CrashFs();
    fs.files.set(oldNameFor("a.md", "live"), enc("old"));
    fs.files.set(tempNameFor("a.md", "live"), enc("new"));
    expect(await recoverDir(fs, "", { busy: new Set(["live"]) })).toEqual([]);
    expect(fs.files.size).toBe(2);
  });
});

describe("atomic saves on the phone folders", () => {
  const phones = [
    ["iOS Documents (Capacitor Filesystem)", () => {
      const f = fakeCapacitorFilesystem();
      return { backend: createMobileBackend(capacitorFs(f.plugin, "DOCUMENTS")), folder: f.folder("DOCUMENTS") };
    }],
    ["Android folder (SAF)", () => {
      const f = fakeSafPlugin();
      const uri = "content://tree/x";
      f.granted.add(uri);
      return { backend: createMobileBackend(safFs(f.plugin, uri)), folder: f.tree(uri) };
    }],
  ] as const;

  for (const [name, make] of phones) {
    it(`${name}: a save goes through a temporary file and leaves nothing behind`, async () => {
      const { backend, folder } = make();
      await backend.write("notes/a.md", "one");
      await backend.write("notes/a.md", "two — שתיים");
      await Promise.all([backend.write("notes/b.md", "b1"), backend.write("notes/b.md", "b2"), backend.write("notes/c.md", "c")]);
      expect(folder.text("notes/a.md")).toBe("two — שתיים");
      expect(folder.text("notes/b.md")).toBe("b2");
      expect(folder.readdir("notes").map((e) => e.name).sort()).toEqual(["a.md", "b.md", "c.md"]);
    });

    it(`${name}: after a crash the note is back the first time its folder is looked at`, async () => {
      const { backend, folder } = make();
      folder.write(`notes/${oldNameFor("a.md", "z1")}`, enc("old"));
      folder.write(`notes/${tempNameFor("a.md", "z1")}`, enc("new"));
      folder.write(`notes/${oldNameFor("b.md", "z2")}`, enc("old b"));
      expect(await backend.readText("notes/b.md")).toBe("old b");
      expect((await backend.list("notes")).map((e) => e.name)).toEqual(["a.md", "b.md"]);
      expect(folder.text("notes/a.md")).toBe("new");
    });
  }
});

describe("atomic saves: leftovers of the OPFS write worker", () => {
  it("the directory-handle backend finishes an interrupted save on list, read and stat", async () => {
    const root = new FakeDir("opfs");
    const backend = createDirectoryHandleBackend({ id: "opfs", root: async () => root as unknown as FileSystemDirectoryHandle });
    const put = async (dir: FakeDir, name: string, text: string) => {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    };
    const notes = await root.getDirectoryHandle("notes", { create: true });
    await put(notes, oldNameFor("a.md", "w1"), "old a");
    await put(notes, tempNameFor("a.md", "w1"), "new a");
    await put(root, oldNameFor("r.md", "w2"), "old r");
    await put(root, "s.md", "s");
    await put(root, tempNameFor("s.md", "w3"), "torn");
    expect(await backend.readText("notes/a.md")).toBe("new a");
    expect((await backend.stat("r.md"))?.kind).toBe("file");
    expect((await backend.list("")).map((e) => e.name)).toEqual(["notes", "r.md", "s.md"]);
    expect([...notes.files.keys()]).toEqual(["a.md"]);
  });
});

describe("atomic saves: a real process killed with SIGKILL", () => {
  it("scripts/vault-crash-test.mjs: 25 kills in the middle of saves, 0 damaged files", () => {
    const script = resolve(__dirname, "..", "..", "scripts", "vault-crash-test.mjs");
    const r = spawnSync(process.execPath, [script, "--kills", "25", "--json"], { encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!) as { kills: number; damaged: number; leftovers: number; files: number };
    expect(out.kills).toBe(25);
    expect(out.damaged).toBe(0);
    expect(out.leftovers).toBe(0);
    expect(out.files).toBeGreaterThan(0);
  }, 150_000);
});
