/**
 * Blind tests (plan W6.15, lane B): the vault integrity check (#356).
 *
 * Written from the spec only: PR #356's body, docs/src/content/docs/workspace/vault-integrity.md
 * and the public API (declarations emitted by tsc, no function bodies). The test list
 * (I1–I8) was written before any implementation was read; the implementation was then
 * opened only to check the import paths (integrity.ts, memory.ts).
 * Failing cases are `it.fails` entries that link to a finding in the W6.15 findings list
 * (PR body of test/blind-tests).
 */
import { describe, expect, it } from "vitest";
import {
  BACKUP_FOLDER,
  INTEGRITY_KINDS,
  REPAIRABLE,
  checkVault,
  repairVault,
  utf8Status,
  type IntegrityFinding,
} from "../../storage/vault/integrity";
import { createMemoryBackend } from "../../storage/vault/memory";
import type { VaultBackend } from "../../storage/vault/types";

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => new Uint8Array(b);
const SHALOM_1255 = bytes(0xf9, 0xec, 0xe5, 0xed); // "שלום" in Windows-1255

async function readBytes(b: VaultBackend, p: string) {
  return new Uint8Array(await (await b.read(p)).arrayBuffer());
}

async function allFiles(b: VaultBackend, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await b.list(dir)) {
    if (e.kind === "directory") out.push(...(await allFiles(b, e.path)));
    else out.push(e.path);
  }
  return out;
}

function utf16(text: string, be: boolean) {
  const out = [be ? 0xfe : 0xff, be ? 0xff : 0xfe];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out.push(...(be ? [c >> 8, c & 0xff] : [c & 0xff, c >> 8]));
  }
  return new Uint8Array(out);
}

async function plantedVault() {
  const b = createMemoryBackend();
  // Healthy files: none of these may show up in the report.
  await b.write("ok.md", "# שלום 👋\r\nCRLF line\r\n[[links]]\n");
  await b.write("fm.md", "---\ntitle: כותרת\ntags: [a, b]\n---\nbody\n");
  await b.write("data.json", '{"a": [1, 2]}');
  await b.write("board.canvas", '{"nodes": [], "edges": []}');
  await b.write("sub/deep/ok2.md", "fine, see [ok](../../ok.md)\n");
  // One of each kind.
  const heb = enc("שלום");
  await b.write("k/truncated.md", heb.slice(0, heb.length - 1));
  await b.write("k/cp1255.md", SHALOM_1255);
  await b.write("k/utf16.md", utf16("hello", false));
  await b.write("k/nul.md", enc("abc\u0000def"));
  await b.write("k/empty.md", new Uint8Array());
  await b.write("k/bad.canvas", '{"nodes": [');
  await b.write("k/badfm.md", "---\ntitle: never closed\nbody\n");
  await b.write("k/Case.md", "one");
  await b.write("k/case.md", "two");
  await b.write("k/café.md", "nfc");
  await b.write("k/café.md", "nfd");
  await b.write("links.md", "see [[Missing note]]\n");
  await b.write("k/orphan.md", "here");
  await b.write("k/.lumen-tmp~orphan.md~t1", "half");
  await b.write("k/.lumen-old~gone.md~t2", "old version");
  return b;
}

describe("utf8Status (I1)", () => {
  it("tells ok, truncated and invalid apart", () => {
    expect(utf8Status(enc("שלום 👋 abc"))).toBe("ok");
    expect(utf8Status(new Uint8Array())).toBe("ok");
    const emoji = enc("a👋");
    expect(utf8Status(emoji.slice(0, emoji.length - 1))).toBe("truncated");
    expect(utf8Status(emoji.slice(0, emoji.length - 3))).toBe("truncated");
    expect(utf8Status(bytes(0xc0, 0x80))).toBe("invalid"); // overlong NUL
    expect(utf8Status(bytes(0xe0, 0x80, 0x80))).toBe("invalid"); // overlong
    expect(utf8Status(bytes(0xed, 0xa0, 0x80))).toBe("invalid"); // surrogate D800
    expect(utf8Status(bytes(0xf4, 0x90, 0x80, 0x80))).toBe("invalid"); // > U+10FFFF
    expect(utf8Status(bytes(0x61, 0x80, 0x62))).toBe("invalid"); // lone continuation
    expect(utf8Status(SHALOM_1255)).toBe("invalid");
  });

  it("agrees with TextDecoder's fatal mode on 2,000 random byte strings", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff;
    const fatal = new TextDecoder("utf-8", { fatal: true });
    for (let i = 0; i < 2000; i++) {
      const b = new Uint8Array(1 + (i % 9)).map(() => rnd());
      let ok = true;
      try {
        fatal.decode(b);
      } catch {
        ok = false;
      }
      const st = utf8Status(b);
      if (ok) expect(st).toBe("ok");
      else expect(st).not.toBe("ok");
    }
  });
});

describe("checkVault (I2, I3)", () => {
  it("lists twelve kinds, eight of them repairable", () => {
    expect(INTEGRITY_KINDS).toHaveLength(12);
    expect(REPAIRABLE.size).toBe(8);
    for (const k of ["empty-file", "bad-data", "bad-frontmatter", "broken-link"] as const) expect(REPAIRABLE.has(k)).toBe(false);
  });

  it("finds 12 of 12 planted kinds, each at its file, and nothing in the healthy files", async () => {
    const b = await plantedVault();
    const r = await checkVault(b);
    const kinds = new Set(r.findings.map((f) => f.kind));
    expect([...kinds].sort()).toEqual([...INTEGRITY_KINDS].sort());
    const at = (kind: string) => r.findings.filter((f) => f.kind === kind).map((f) => f.path);
    expect(at("truncated-utf8")).toEqual(["k/truncated.md"]);
    expect(at("invalid-utf8")).toEqual(["k/cp1255.md"]);
    expect(at("utf16")).toEqual(["k/utf16.md"]);
    expect(at("nul-bytes")).toEqual(["k/nul.md"]);
    expect(at("empty-file")).toEqual(["k/empty.md"]);
    expect(at("bad-data")).toEqual(["k/bad.canvas"]);
    expect(at("bad-frontmatter")).toEqual(["k/badfm.md"]);
    expect(at("case-collision")).toHaveLength(1);
    expect(["k/Case.md", "k/case.md"]).toContain(at("case-collision")[0]);
    expect(at("normalization-collision")).toHaveLength(1);
    expect(at("broken-link")).toEqual(["links.md"]);
    expect(at("orphan-temp")).toEqual(["k/.lumen-tmp~orphan.md~t1"]);
    expect(at("interrupted-write")).toEqual(["k/gone.md"]);
    const healthy = ["ok.md", "fm.md", "data.json", "board.canvas", "sub/deep/ok2.md", "k/orphan.md"];
    for (const f of r.findings) expect(healthy).not.toContain(f.path);
  });

  it("doesn't look into .git, .trash or earlier backups", async () => {
    const b = createMemoryBackend();
    await b.write("a.md", "fine");
    await b.write(".git/objects/x", SHALOM_1255);
    await b.write(".trash/old.md", new Uint8Array());
    await b.write(`${BACKUP_FOLDER}/2026/k.md`, SHALOM_1255);
    const r = await checkVault(b);
    expect(r.findings).toEqual([]);
  });
});

describe("repairVault (I4–I7)", () => {
  it("backs up every file byte for byte before it changes, then repairs it", async () => {
    const b = await plantedVault();
    const before = new Map<string, Uint8Array>();
    for (const p of await allFiles(b)) before.set(p, await readBytes(b, p));
    const r = await checkVault(b);
    const res = await repairVault(b, r.findings, { stamp: "T1" });
    expect(res.backup).not.toBeNull();
    const repairedPaths = res.repaired.map((f) => f.path);
    for (const f of res.repaired) {
      if (f.kind === "interrupted-write") continue; // the note itself was missing
      const copyPath = `${res.backup}/${f.path}`;
      expect(before.get(f.path)).toBeDefined();
      expect([...(await readBytes(b, copyPath))]).toEqual([...before.get(f.path)!]);
    }
    expect(await b.readText("k/cp1255.md")).toBe("שלום");
    expect(await b.readText("k/utf16.md")).toBe("hello");
    expect(await b.readText("k/nul.md")).toBe("abcdef");
    expect(await b.readText("k/truncated.md")).toBe("שלו");
    expect(await b.readText("k/gone.md")).toBe("old version");
    expect(await b.stat("k/.lumen-tmp~orphan.md~t1")).toBeNull();
    expect(await b.readText("k/orphan.md")).toBe("here");
    // Not repairable: reported, left as they were.
    for (const p of ["k/empty.md", "k/bad.canvas", "k/badfm.md", "links.md"]) {
      expect(repairedPaths).not.toContain(p);
      expect([...(await readBytes(b, p))]).toEqual([...before.get(p)!]);
    }
    // F-2 (ambiguity, Low): the orphan temp file is gone (asserted above), but it can be
    // listed as "skipped" because another repair in its folder removed it first.
    expect(res.skipped.map((f) => f.kind).filter((k) => k !== "orphan-temp").sort()).toEqual(["bad-data", "bad-frontmatter", "broken-link", "empty-file"]);
    // After the repair only the four unrepairable kinds are left.
    const again = await checkVault(b);
    expect(new Set(again.findings.map((f) => f.kind))).toEqual(new Set(["bad-data", "bad-frontmatter", "broken-link", "empty-file"]));
  });

  it("UTF-16 big-endian becomes UTF-8 too", async () => {
    const b = createMemoryBackend();
    await b.write("be.md", utf16("שלום", true));
    const r = await checkVault(b);
    expect(r.findings.map((f) => f.kind)).toEqual(["utf16"]);
    await repairVault(b, r.findings, { stamp: "T2" });
    expect(await b.readText("be.md")).toBe("שלום");
  });

  it("a colliding name becomes 'name (2)', and an existing 'name (2)' is never overwritten", async () => {
    const b = createMemoryBackend();
    await b.write("Note.md", "upper");
    await b.write("note.md", "lower");
    await b.write("note (2).md", "already here");
    await b.write("Note (2).md", "also here");
    const r = await checkVault(b);
    const col = r.findings.filter((f) => f.kind === "case-collision");
    expect(col.length).toBeGreaterThan(0);
    await repairVault(b, col, { stamp: "T3" });
    const texts = [];
    for (const p of await allFiles(b)) if (!p.startsWith(BACKUP_FOLDER)) texts.push(await b.readText(p));
    expect(texts.sort()).toEqual(["already here", "also here", "lower", "upper"].sort());
  });

  it("a file that changed since the check is left alone", async () => {
    const b = createMemoryBackend();
    await b.write("x.md", SHALOM_1255);
    const r = await checkVault(b);
    await b.write("x.md", "the user fixed it meanwhile");
    const res = await repairVault(b, r.findings, { stamp: "T4" });
    expect(res.repaired).toEqual([]);
    expect(res.skipped.map((f) => f.path)).toEqual(["x.md"]);
    expect(await b.readText("x.md")).toBe("the user fixed it meanwhile");
  });

  it("nothing repairable: no backup folder", async () => {
    const b = createMemoryBackend();
    await b.write("e.md", new Uint8Array());
    const r = await checkVault(b);
    const res = await repairVault(b, r.findings as IntegrityFinding[], { stamp: "T5" });
    expect(res.backup).toBeNull();
    expect(await b.stat(BACKUP_FOLDER)).toBeNull();
  });
});

// I8 (speed) is a wall-clock budget: it runs in the nightly perf tier, blindIntegrityPerf.test.ts.
