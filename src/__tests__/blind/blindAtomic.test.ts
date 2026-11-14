/**
 * Blind tests (plan W6.15, lane B): vault atomic writes (#356).
 *
 * Written from the spec only: PR #356's body, docs/src/content/docs/workspace/vault-integrity.md
 * and the public API (declarations emitted by tsc, no function bodies). The test list
 * (A1–A12) was written before any implementation was read; the implementation was then
 * opened only to check the import path. The in-memory file system and its crash
 * injection are this file's own, built from the `AtomicFs` interface.
 * Failing cases are `it.fails` entries that link to a finding in the W6.15 findings list
 * (PR body of test/blind-tests).
 */
import { describe, expect, it } from "vitest";
import {
  atomicWrite,
  hasLeftovers,
  isTempName,
  oldNameFor,
  parseLeftover,
  recoverDir,
  saveId,
  tempNameFor,
  type AtomicFs,
} from "../../storage/vault/atomic";

class Crash extends Error {}

/** A flat in-memory disk: path → bytes. Folders are implied by the paths. */
function memFs(init: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(init));
  let ops = 0;
  let crashAt = -1;
  let torn = false;
  let short = false;
  const step = () => {
    if (ops++ === crashAt) throw new Crash("killed");
  };
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const fs: AtomicFs = {
    async readdir(dir) {
      const prefix = dir ? `${dir}/` : "";
      const out = new Map<string, "file" | "directory">();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) out.set(rest, "file");
        else out.set(rest.slice(0, slash), "directory");
      }
      return [...out].map(([name, type]) => ({ name, type }));
    },
    async exists(path) {
      if (files.has(path)) return true;
      for (const p of files.keys()) if (p.startsWith(`${path}/`)) return true;
      return false;
    },
    async writeFile(path, data) {
      if (torn && ops === crashAt) {
        ops++;
        files.set(path, data.slice(0, Math.floor(data.length / 2)));
        throw new Crash("torn write");
      }
      step();
      files.set(path, short ? data.slice(0, Math.max(0, data.length - 3)) : data.slice());
    },
    async size(path) {
      return files.get(path)?.length ?? null;
    },
    async rename(from, to) {
      step();
      const d = files.get(from);
      if (!d) throw new Error(`ENOENT ${from}`);
      if (files.has(to)) throw new Error(`EEXIST ${to}`);
      files.delete(from);
      files.set(to, d);
    },
    async remove(path) {
      step();
      if (!files.delete(path)) throw new Error(`ENOENT ${path}`);
    },
  };
  return {
    fs,
    files,
    join,
    get ops() {
      return ops;
    },
    arm(at: number, opts: { torn?: boolean; short?: boolean } = {}) {
      ops = 0;
      crashAt = at;
      torn = !!opts.torn;
      short = !!opts.short;
    },
    disarm() {
      crashAt = -1;
      torn = false;
      short = false;
    },
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);
const OLD = "# ישן\n" + "old line\n".repeat(200);
const NEW = "# חדש\n" + "new line, longer than the old one\n".repeat(300);

function leftovers(files: Map<string, Uint8Array>) {
  return [...files.keys()].filter((p) => {
    const base = p.split("/").pop()!;
    return parseLeftover(base) !== null || isTempName(base);
  });
}

/** Count the mutating steps of a clean save. */
async function stepsOfCleanSave(withOld: boolean, path = "note.md") {
  const m = memFs(withOld ? { [path]: enc(OLD) } : {});
  m.arm(-1);
  await atomicWrite(m.fs, path, enc(NEW));
  return m.ops;
}

describe("names of the save steps (A1, A2, A11)", () => {
  it("temp and old names round-trip through parseLeftover, Hebrew and '~' included", () => {
    for (const name of ["note.md", "פתק עם רווחים.md", "a~b~c.md", "x.canvas", ".hidden.md"]) {
      const id = saveId();
      expect(parseLeftover(tempNameFor(name, id))).toEqual({ kind: "tmp", target: name, id });
      expect(parseLeftover(oldNameFor(name, id))).toEqual({ kind: "old", target: name, id });
      expect(isTempName(tempNameFor(name, id))).toBe(true);
    }
  });

  it("ordinary names are not leftovers", () => {
    for (const name of ["note.md", "lumen-tmp.md", ".lumen-tmpfile", "a~b.md", "Lumen sync", ".lumen-repair"]) {
      expect(parseLeftover(name)).toBeNull();
    }
    expect(isTempName("note.md")).toBe(false);
  });

  it("Chrome's swap file counts as a temporary file", () => {
    expect(isTempName("note.md.crswap")).toBe(true);
  });

  it("save ids are distinct", () => {
    const ids = new Set(Array.from({ length: 500 }, () => saveId()));
    expect(ids.size).toBe(500);
  });

  it("hasLeftovers sees an interrupted save and nothing else", () => {
    expect(hasLeftovers(["a.md", "b.md", "sub"])).toBe(false);
    expect(hasLeftovers(["a.md", tempNameFor("a.md", "x1")])).toBe(true);
    expect(hasLeftovers([oldNameFor("b.md", "x2")])).toBe(true);
  });
});

describe("a clean save (A3)", () => {
  it("creates a note, replaces it, and leaves nothing behind", async () => {
    const m = memFs();
    await atomicWrite(m.fs, "dir/note.md", enc(OLD));
    expect(dec(m.files.get("dir/note.md"))).toBe(OLD);
    await atomicWrite(m.fs, "dir/note.md", enc(NEW));
    expect(dec(m.files.get("dir/note.md"))).toBe(NEW);
    expect(leftovers(m.files)).toEqual([]);
    expect([...m.files.keys()]).toEqual(["dir/note.md"]);
  });

  it("an empty note is a valid save", async () => {
    const m = memFs({ "e.md": enc(OLD) });
    await atomicWrite(m.fs, "e.md", new Uint8Array());
    expect(m.files.get("e.md")?.length).toBe(0);
    expect(leftovers(m.files)).toEqual([]);
  });
});

async function check(m: ReturnType<typeof memFs>, path: string, allowMissing: boolean) {
  m.disarm();
  await recoverDir(m.fs, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  const got = dec(m.files.get(path));
  if (got === undefined) expect(allowMissing).toBe(true);
  else expect([OLD, NEW]).toContain(got);
  expect(leftovers(m.files)).toEqual([]);
  return got;
}

describe("a crash at every step (A4, A5, A7)", () => {
  for (const withOld of [true, false]) {
    it(`${withOld ? "an existing" : "a new"} note: old or new, whole, after a kill at each step`, async () => {
      const n = await stepsOfCleanSave(withOld);
      expect(n).toBeGreaterThan(0);
      const seen = new Set<string | undefined>();
      for (let k = 0; k <= n; k++) {
        const m = memFs(withOld ? { "note.md": enc(OLD) } : {});
        m.arm(k);
        await atomicWrite(m.fs, "note.md", enc(NEW)).catch((e) => {
          if (!(e instanceof Crash)) throw e;
        });
        seen.add(await check(m, "note.md", !withOld));
      }
      // Both outcomes must be reachable for an existing note (the crash point decides).
      if (withOld) expect([...seen].sort()).toEqual([NEW, OLD].sort());
    });

    it(`${withOld ? "an existing" : "a new"} note: a torn write of the temporary file never wins`, async () => {
      const n = await stepsOfCleanSave(withOld);
      for (let k = 0; k <= n; k++) {
        const m = memFs(withOld ? { "note.md": enc(OLD) } : {});
        m.arm(k, { torn: true });
        await atomicWrite(m.fs, "note.md", enc(NEW)).catch((e) => {
          if (!(e instanceof Crash)) throw e;
        });
        await check(m, "note.md", !withOld);
      }
    });
  }

  it("a crash during recovery, then recovery again: still old or new", async () => {
    const n = await stepsOfCleanSave(true);
    for (let k = 0; k <= n; k++) {
      for (let j = 0; j < 6; j++) {
        const m = memFs({ "note.md": enc(OLD) });
        m.arm(k);
        await atomicWrite(m.fs, "note.md", enc(NEW)).catch((e) => {
          if (!(e instanceof Crash)) throw e;
        });
        m.arm(j);
        await recoverDir(m.fs, "").catch((e) => {
          if (!(e instanceof Crash)) throw e;
        });
        await check(m, "note.md", false);
      }
    }
  });
});

describe("short writes and busy saves (A6, A8, A9)", () => {
  it("a write the platform cut short (no error) never replaces a good note", async () => {
    const m = memFs({ "note.md": enc(OLD) });
    m.arm(-1, { short: true });
    let threw = false;
    await atomicWrite(m.fs, "note.md", enc(NEW)).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    m.disarm();
    await recoverDir(m.fs, "");
    expect(dec(m.files.get("note.md"))).toBe(OLD);
    expect(leftovers(m.files)).toEqual([]);
  });

  it("recovery leaves the files of a save that is still running alone", async () => {
    const id = "busy1";
    const m = memFs({ "note.md": enc(OLD), [tempNameFor("note.md", id)]: enc(NEW) });
    const actions = await recoverDir(m.fs, "", { busy: new Set([id]) });
    expect(actions).toEqual([]);
    expect(m.files.has(tempNameFor("note.md", id))).toBe(true);
  });

  it("recovery in a sub-folder reports vault-relative paths and finishes the save", async () => {
    const id = "s1";
    const m = memFs({
      [`a/b/${oldNameFor("n.md", id)}`]: enc(OLD),
      [`a/b/${tempNameFor("n.md", id)}`]: enc(NEW),
    });
    const actions = await recoverDir(m.fs, "a/b");
    expect(actions).toEqual([{ path: "a/b/n.md", action: "promoted" }]);
    expect(dec(m.files.get("a/b/n.md"))).toBe(NEW);
    expect(leftovers(m.files)).toEqual([]);
  });

  it("with the note missing and only its old copy left, the old version comes back", async () => {
    const m = memFs({ [oldNameFor("n.md", "z9")]: enc(OLD) });
    const actions = await recoverDir(m.fs, "");
    expect(actions).toEqual([{ path: "n.md", action: "restored" }]);
    expect(dec(m.files.get("n.md"))).toBe(OLD);
  });
});

describe("1,000 random kills (A10)", () => {
  it("0 damaged notes over 1,000 seeded saves, each stopped at a random step", async () => {
    let seed = 0x5eed;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const n = await stepsOfCleanSave(true);
    let damaged = 0;
    for (let i = 0; i < 1000; i++) {
      const m = memFs({ "note.md": enc(OLD) });
      m.arm(rnd(n + 1), { torn: rnd(2) === 1 });
      await atomicWrite(m.fs, "note.md", enc(NEW)).catch(() => undefined);
      m.disarm();
      await recoverDir(m.fs, "");
      const got = dec(m.files.get("note.md"));
      if ((got !== OLD && got !== NEW) || leftovers(m.files).length) damaged++;
    }
    expect(damaged).toBe(0);
  });
});

describe("long names (A12, adversarial)", () => {
  // F-1 (Medium): a name the file systems accept (≤ 255 bytes) gets a 266-byte
  // temporary name, so step 1 fails with ENAMETOOLONG on the phones' folders.
  it("a 240-byte note name gets a temporary name of at most 255 bytes (F-1)", () => {
    const name = "א".repeat(118) + ".md"; // 118 × 2 + 3 = 239 bytes of UTF-8
    expect(enc(name).length).toBeLessThanOrEqual(255);
    const id = saveId();
    expect(enc(tempNameFor(name, id)).length).toBeLessThanOrEqual(255);
    expect(enc(oldNameFor(name, id)).length).toBeLessThanOrEqual(255);
  });
});
