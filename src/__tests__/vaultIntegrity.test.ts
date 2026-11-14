/**
 * The vault integrity check (plan W1.5, src/storage/vault/integrity.ts):
 * a test vault with one planted defect of each of the twelve kinds, healthy
 * files that must not be reported, the repairs with their backups, and the
 * time it takes on 10,000 notes.
 */
import { describe, expect, it } from "vitest";
import { createMemoryBackend, type VaultBackend } from "../storage/vault";
import { journalBytes, journalNameFor, oldNameFor, saveId, tempNameFor } from "../storage/vault/atomic";
import { BACKUP_FOLDER, checkVault, INTEGRITY_KINDS, REPAIRABLE, repairVault, utf8Status, type IntegrityKind } from "../storage/vault/integrity";

const enc = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string) => {
  const out = new Uint8Array(2 + s.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) & 0xff;
    out[3 + i * 2] = s.charCodeAt(i) >> 8;
  }
  return out;
};
const text = async (b: VaultBackend, p: string) => b.readText(p);

/** The test vault: every planted defect, and healthy files next to them. */
async function plantedVault(): Promise<VaultBackend> {
  const b = createMemoryBackend();
  const shalom = enc("שלום עולם");
  // 1 truncated-utf8: the last Hebrew letter is cut after its first byte.
  await b.write("cut.md", shalom.subarray(0, shalom.length - 1));
  // 2 invalid-utf8: "שלום" in Windows-1255.
  await b.write("legacy.md", new Uint8Array([0xf9, 0xec, 0xe5, 0xed, 0x0a]));
  // 3 utf16: saved as UTF-16 by another editor.
  await b.write("wide.txt", utf16le("hello"));
  // 4 nul-bytes: a write that zero-filled.
  await b.write("zeros.md", enc("before\0\0\0after"));
  // 5 empty-file.
  await b.write("empty.md", "");
  // 6 bad-data: a canvas cut half way.
  await b.write("board.canvas", '{"nodes": [{"id": "a"');
  // 7 bad-frontmatter: never closed.
  await b.write("meta.md", "---\ntitle: Open\ntags: [a, b]\n\n# Body");
  // 8 case-collision.
  await b.write("projects/Plan.md", "# Plan");
  await b.write("projects/plan.md", "# plan");
  // 9 normalization-collision: é composed and decomposed.
  await b.write("café.md", "NFC");
  await b.write("café.md", "NFD");
  // 10 broken-link.
  await b.write("links.md", "See [[Plan]] and [[Nowhere to be found]].");
  // 11 orphan-temp: the desktop app's and Chromium's.
  await b.write(".lumen-tmp-4242-7", "half");
  await b.write("projects/Plan.md.crswap", "swap");
  // 12 interrupted-write: the note is missing, both versions are there.
  await b.write(`notes/${oldNameFor("gone.md", "k1")}`, "old gone");
  await b.write(`notes/${tempNameFor("gone.md", "k1")}`, "new gone");
  // Healthy files: none of these may be reported.
  await b.write("notes/ok.md", "---\ntitle: Fine\ntags:\n  - a\n---\n\n# שלום\n\n[[links]] and [the plan](../projects/Plan.md)");
  await b.write("notes/board.excalidraw", JSON.stringify({ type: "excalidraw", elements: [] }));
  await b.write("notes/view.base", "filters:\n  and:\n    - file.ext == \"md\"\n");
  await b.write("image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff]));
  await b.write(".trash/old.md", "");
  return b;
}

const kinds = (fs: Array<{ kind: IntegrityKind }>) => [...new Set(fs.map((f) => f.kind))].sort();

describe("vault integrity check", () => {
  it("finds 12 of 12 planted kinds of damage, each where it was planted, and nothing in the healthy files", async () => {
    const b = await plantedVault();
    const r = await checkVault(b);
    expect(INTEGRITY_KINDS).toHaveLength(12);
    expect(kinds(r.findings)).toEqual([...INTEGRITY_KINDS].sort());
    const where = Object.fromEntries(INTEGRITY_KINDS.map((k) => [k, r.findings.filter((f) => f.kind === k).map((f) => f.path).sort()]));
    expect(where).toEqual({
      "truncated-utf8": ["cut.md"],
      "invalid-utf8": ["legacy.md"],
      utf16: ["wide.txt"],
      "nul-bytes": ["zeros.md"],
      "empty-file": ["empty.md"],
      "bad-data": ["board.canvas"],
      "bad-frontmatter": ["meta.md"],
      "case-collision": ["projects/plan.md"],
      "normalization-collision": [["café.md", "café.md"].sort()[1]],
      "broken-link": ["links.md"],
      "orphan-temp": [".lumen-tmp-4242-7", "projects/Plan.md.crswap"],
      "interrupted-write": ["notes/gone.md"],
    });
    expect(r.findings.find((f) => f.kind === "broken-link")?.detail).toBe("[[Nowhere to be found]]");
    expect(r.findings.find((f) => f.kind === "bad-frontmatter")?.detail).toBe("never closed");
  });

  it("reports invalid YAML in front matter and .base files", async () => {
    const b = createMemoryBackend();
    await b.write("a.md", "---\ntitle: [unclosed\n---\nbody");
    await b.write("v.base", "filters: [\n");
    const r = await checkVault(b);
    expect(r.findings.map((f) => `${f.kind}:${f.path}`).sort()).toEqual(["bad-data:v.base", "bad-frontmatter:a.md"]);
  });

  it("utf8Status tells a cut last character from bad bytes", () => {
    const e = enc("aש€😀");
    expect(utf8Status(e)).toBe("ok");
    for (let cut = 1; cut <= 3; cut++) expect(utf8Status(e.subarray(0, e.length - cut))).toBe("truncated");
    expect(utf8Status(new Uint8Array([0x61, 0xc0, 0x80]))).toBe("invalid"); // overlong
    expect(utf8Status(new Uint8Array([0xed, 0xa0, 0x80]))).toBe("invalid"); // surrogate
    expect(utf8Status(new Uint8Array([0xd7, 0x41]))).toBe("invalid");
  });

  it("repairs with one click: a backup of every file first, then the fix; the vault checks clean after", async () => {
    const b = await plantedVault();
    const before = await checkVault(b);
    const r = await repairVault(b, before.findings, { stamp: "t1" });
    expect(r.backup).toBe(`${BACKUP_FOLDER}/t1`);
    expect(kinds(r.repaired)).toEqual([...REPAIRABLE].sort());
    expect(kinds(r.skipped)).toEqual(["bad-data", "bad-frontmatter", "broken-link", "empty-file"]);

    expect(await text(b, "cut.md")).toBe("שלום עול");
    expect(await text(b, "zeros.md")).toBe("beforeafter");
    expect(await text(b, "wide.txt")).toBe("hello");
    expect(await text(b, "notes/gone.md")).toBe("new gone");
    expect(await text(b, "projects/Plan.md")).toBe("# Plan");
    expect(await text(b, "projects/plan (2).md")).toBe("# plan");
    // The originals, byte for byte, in the backup.
    expect(new Uint8Array(await (await b.read(`${BACKUP_FOLDER}/t1/legacy.md`)).arrayBuffer())).toEqual(new Uint8Array([0xf9, 0xec, 0xe5, 0xed, 0x0a]));
    expect(await text(b, `${BACKUP_FOLDER}/t1/projects/plan.md`)).toBe("# plan");
    expect(await text(b, `${BACKUP_FOLDER}/t1/.lumen-tmp-4242-7`)).toBe("half");

    const after = await checkVault(b);
    // Windows-1255 → UTF-8 (Node and the browsers ship the decoder).
    expect(await text(b, "legacy.md")).toBe("שלום\n");
    expect(kinds(after.findings)).toEqual(["bad-data", "bad-frontmatter", "broken-link", "empty-file"]);
  });

  it("leaves a file alone when it no longer shows the problem", async () => {
    const b = createMemoryBackend();
    await b.write("z.md", "a\0b");
    const { findings } = await checkVault(b);
    await b.write("z.md", "fixed elsewhere");
    const r = await repairVault(b, findings, { stamp: "t2" });
    expect(r.repaired).toEqual([]);
    expect(r.backup).toBeNull();
    expect(await text(b, "z.md")).toBe("fixed elsewhere");
  });

  it("checks 10,000 notes in under 5 seconds", async () => {
    const b = createMemoryBackend();
    const body = "שלום עולם. A paragraph of an ordinary note, with a little **bold** text.\n".repeat(8);
    for (let i = 0; i < 10_000; i++) {
      await b.write(`area${i % 100}/note ${i}.md`, `---\ntitle: Note ${i}\ntags: [t${i % 7}]\n---\n\n# Note ${i}\n\n${body}\nSee [[note ${(i + 1) % 10_000}]].\n`);
    }
    const r = await checkVault(b);
    expect(r.files).toBe(10_000);
    expect(r.findings).toEqual([]);
    expect(r.ms).toBeLessThan(5000);
  }, 60_000);
  it("a second check reads only what changed (size or mtime), and nothing changed in the seconds before the last check", async () => {
    const b = createMemoryBackend();
    for (let i = 0; i < 50; i++) await b.write(`n${i}.md`, `# ${i}\n[[n${(i + 1) % 50}]]\n`);
    const reads: string[] = [];
    const counted: VaultBackend = { ...b, read: (p) => (reads.push(p), b.read(p)), list: (d) => b.list(d) };
    const realNow = Date.now;
    try {
      // The files are "an hour old" for both checks.
      Date.now = () => realNow() + 3_600_000;
      expect((await checkVault(counted)).findings).toEqual([]);
      expect(reads.length).toBe(50);
      reads.length = 0;
      expect((await checkVault(counted)).files).toBe(50);
      expect(reads).toEqual([]);
      // A file that changed (another size) is read again, and its new damage is found.
      await b.write("n3.md", new Uint8Array([0x23, 0x20, 0xd7]));
      const r = await checkVault(counted);
      expect(reads).toEqual(["n3.md"]);
      expect(r.findings[0]).toEqual({ kind: "truncated-utf8", path: "n3.md" });
      reads.length = 0;
      // In real time every file changed less than 3 s ago: none is trusted, all are read.
      Date.now = realNow;
      await checkVault(counted);
      expect(reads.length).toBe(50);
      reads.length = 0;
      await checkVault(counted, { reuse: false });
      expect(reads.length).toBe(50);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("vault integrity check: saves with short names (255-byte note names)", () => {
  const LONG = "א".repeat(126) + ".md";
  it("an interrupted save is traced to its note through the journal and finished; without a journal its old version is an orphan, kept in the backup", async () => {
    const b = createMemoryBackend();
    const id = saveId();
    await b.write(`notes/${journalNameFor(LONG, id)}`, journalBytes(LONG));
    await b.write(`notes/${oldNameFor(LONG, id)}`, "old");
    await b.write(`notes/${tempNameFor(LONG, id)}`, "new");
    const lone = saveId();
    await b.write(oldNameFor(LONG, lone), "old, note unknown");
    const report = await checkVault(b);
    expect(report.findings).toEqual([
      { kind: "interrupted-write", path: `notes/${LONG}`, detail: `notes/${oldNameFor(LONG, id)}` },
      { kind: "orphan-temp", path: oldNameFor(LONG, lone) },
    ]);
    const res = await repairVault(b, report.findings, { stamp: "t" });
    expect(res.skipped).toEqual([]);
    expect(await b.readText(`notes/${LONG}`)).toBe("new");
    expect((await b.list("notes")).map((e) => e.name)).toEqual([LONG]);
    expect(await b.readText(`${BACKUP_FOLDER}/t/${oldNameFor(LONG, lone)}`)).toBe("old, note unknown");
  });
});
