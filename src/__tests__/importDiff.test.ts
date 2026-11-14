/**
 * Plan W11.P2 — `npm run import:diff`: the same export through lumen-md and
 * through Obsidian Importer (the oracle), compared on notes, attachments,
 * internal links, headings, tasks, Hebrew (NFC, word for word) and
 * direction marks; the gate fails on a shortfall over 1%, and on any
 * shortfall without an explanation.
 *
 * The real comparison here uses Obsidian Importer 3.1.15's own outputs for
 * its 16 public Keep test notes (tests/keep/notes/expected, copied
 * unchanged; see fixtures/obsidian-importer/SOURCES.md), against lumen-md's
 * Keep importer on the same notes. Public examples, not real exports.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
// @ts-expect-error — plain .mjs helpers without types
import { MAX_SHORTFALL, compareVaults, diffMarkdown, readVault, vaultMetrics } from "../../scripts/lib/importDiff.mjs";
import { convertKeep } from "../storage/import/keep";

const FIX = "src/__tests__/fixtures/obsidian-importer";
type Vault = Map<string, string | Uint8Array>;
const v = (o: Record<string, string>): Vault => new Map(Object.entries(o));

describe("the metrics", () => {
  it("count notes, attachments, links, headings, tasks, Hebrew words and direction marks; front matter and code fences are not content", () => {
    const m = vaultMetrics(
      new Map<string, string | Uint8Array>([
        ["a.md", "---\ntitle: '# not a heading'\n---\n# כותרת\n\n- [ ] משימה\n- [X] done\n[[b]] ![[img.png]] [x](b.md) [web](https://example.org)\n‏שלום‎\n```\n# not a heading\n- [ ] not a task\n```\n"],
        ["b.md", "## Two\n"],
        ["img.png", new Uint8Array([1])],
        [".obsidian/x.json", "{}"],
      ]),
    ).metrics;
    expect(m).toEqual({ notes: 2, attachments: 2, links: 3, headings: 2, tasks: 2, hebrew: 3, bidi: 2 });
  });
});

describe("the gate", () => {
  const oracle = v({ "a.md": "# A\n[[b]]\n", "b.md": "# B\n" });
  it("lumen-md at or above the oracle on every metric passes", () => {
    const r = compareVaults(v({ "a.md": "# A\n[[b]] [[c]]\n", "b.md": "# B\n", "c.md": "# C\n" }), oracle);
    expect(r.pass).toBe(true);
    expect(r.rows.every((x: { status: string }) => x.status === "pass")).toBe(true);
  });
  it("a shortfall over 1% fails, explained or not", () => {
    const lumen = v({ "a.md": "# A\n", "b.md": "# B\n" });
    expect(compareVaults(lumen, oracle).pass).toBe(false);
    const r = compareVaults(lumen, oracle, { links: "dropped on purpose" });
    expect(r.pass).toBe(false);
    expect(r.rows.find((x: { metric: string }) => x.metric === "links")).toMatchObject({ status: "fail", shortBy: 1 });
    expect(MAX_SHORTFALL).toBe(0.01);
  });
  it("a shortfall of ≤ 1% fails without an explanation and passes with one", () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}.md`, `# ${i}\n`]));
    const o = v(many(200));
    const l = v(many(198)); // 1%
    expect(compareVaults(l, o).pass).toBe(false);
    const r = compareVaults(l, o, { notes: "two empty notes left out on purpose", headings: "the same two notes" });
    expect(r.pass).toBe(true);
    expect(r.rows.find((x: { metric: string }) => x.metric === "notes")).toMatchObject({ status: "explained", shortBy: 2 });
  });
  it("Hebrew is compared word for word after NFC: the same total with a different word is a shortfall", () => {
    const decomposed = "שָׁלוֹם".normalize("NFD");
    expect(compareVaults(v({ "a.md": decomposed }), v({ "a.md": "שָׁלוֹם".normalize("NFC") })).pass).toBe(true);
    const r = compareVaults(v({ "a.md": "שלום עולם" }), v({ "a.md": "שלום עולמי" }));
    expect(r.pass).toBe(false);
    expect(r.rows.find((x: { metric: string }) => x.metric === "hebrew")).toMatchObject({ shortBy: 1, missingWords: ["עולמי"] });
  });
  it("a lost direction mark is a shortfall", () => {
    expect(compareVaults(v({ "a.md": "abc" }), v({ "a.md": "a‏bc" })).pass).toBe(false);
  });
});

/** The oracle's vault for the Keep notes, with Obsidian Importer's defaults: archived and trashed notes are not imported. */
function oracleKeep(): Vault {
  const out: Vault = new Map();
  for (const n of readdirSync(`${FIX}/keep-expected`).sort()) {
    if (n === "Deleted note.md" || n === "Archived note.md") continue;
    out.set(n, readFileSync(`${FIX}/keep-expected/${n}`, "utf8"));
  }
  return out;
}
function lumenKeep(): Vault {
  const files = new Map(readdirSync(`${FIX}/keep`).filter((n) => n.endsWith(".json")).map((n) => [`Takeout/Keep/${n}`, new Uint8Array(readFileSync(`${FIX}/keep/${n}`))] as [string, Uint8Array]));
  const c = convertKeep(files);
  return new Map<string, string | Uint8Array>([...c.notes, ...c.attachments]);
}

describe("lumen-md against Obsidian Importer, on the importer's own Keep notes", () => {
  it("the oracle outputs are the importer's files, byte for byte", () => {
    const sources = readFileSync(`${FIX}/SOURCES.md`, "utf8");
    for (const n of readdirSync(`${FIX}/keep-expected`)) {
      const sha = createHash("sha256").update(readFileSync(`${FIX}/keep-expected/${n}`)).digest("hex");
      expect(sources, n).toContain(sha);
    }
  });

  it("passes the gate: lumen-md reaches the oracle on every metric", () => {
    const r = compareVaults(lumenKeep(), oracleKeep());
    const table = diffMarkdown(r, "Keep (obsidian-importer fixtures)");
    expect(r.pass, table).toBe(true);
    const row = (m: string) => r.rows.find((x: { metric: string }) => x.metric === m);
    expect(row("notes")).toMatchObject({ oracle: 14 });
    expect(row("notes").lumen).toBeGreaterThanOrEqual(14); // + the archived note, which lumen-md keeps in Archive/
    expect(row("tasks").oracle).toBeGreaterThan(0);
    expect(row("links").oracle).toBeGreaterThan(0);
  });
});

describe("npm run import:diff", () => {
  const script = join(process.cwd(), "scripts/import-diff.mjs");
  const write = (root: string, vault: Vault) => {
    for (const [p, c] of vault) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    }
  };
  it("reads two folders, prints the table, exits 0 on pass and 1 on fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-diff-"));
    try {
      write(join(dir, "lumen"), lumenKeep());
      write(join(dir, "oracle"), oracleKeep());
      mkdirSync(join(dir, "oracle/.obsidian"), { recursive: true });
      writeFileSync(join(dir, "oracle/.obsidian/app.json"), "{}");
      expect(readVault(join(dir, "oracle")).has(".obsidian/app.json")).toBe(false);
      const ok = spawnSync(process.execPath, [script, "--lumen", join(dir, "lumen"), "--oracle", join(dir, "oracle")], { encoding: "utf8" });
      expect(ok.stdout).toContain(": PASS");
      expect(ok.status).toBe(0);
      writeFileSync(join(dir, "oracle/extra.md"), "# Extra\n[[x]] [[y]]\n- [ ] t\n");
      const bad = spawnSync(process.execPath, [script, "--lumen", join(dir, "lumen"), "--oracle", join(dir, "oracle"), "--json"], { encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(JSON.parse(bad.stdout).pass).toBe(false);
      expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("1,000 notes: lumen-md's Keep import converts them in well under 60 s here (synthetic notes)", () => {
    const files = new Map<string, Uint8Array>();
    const enc = new TextEncoder();
    for (let i = 0; i < 1000; i++) files.set(`Takeout/Keep/n${i}.json`, enc.encode(JSON.stringify({ title: `Synthetic ${i}`, textContent: `שורה ${i} [[n${i + 1}]]`, listContent: [{ text: "a", isChecked: false }], createdTimestampUsec: 1.7e15 + i, userEditedTimestampUsec: 1.7e15 + i })));
    const t0 = performance.now();
    const c = convertKeep(files);
    const ms = performance.now() - t0;
    expect(c.notes.size).toBe(1000);
    expect(ms).toBeLessThan(60_000);
  });
});
