/**
 * W2.22 — the compact vault index (chunked search texts) returns exactly
 * what the previous core returned (kept in helpers/vaultIndexReference.ts),
 * through random notes in Hebrew, English and mixed, with niqqud, final
 * letters, prefixes and folded punctuation, random edits, moves and
 * deletes, and random queries.
 */
import { describe, expect, it } from "vitest";
import { VaultIndex, foldForSearch, type IndexInput } from "../storage/vaultIndexCore";
import { ReferenceVaultIndex, foldForSearch as referenceFold } from "./helpers/vaultIndexReference";

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

const WORDS = [
  "שלום", "שָׁלוֹם", "ובית", "הבית", "בית", "ספרים", "מחברת", "ירושלים", "צה״ל", "צה\"ל", "ג'ירפה", "ג׳ירפה", "תל־אביב", "תל-אביב",
  "Hello", "hello", "LUMEN", "lumen", "vault", "Index", "it's", "it’s", "“quoted”", "\"quoted\"", "ΣΟΦΙΑ", "café", "naïve",
  "2026", "1:", "(x)", "-", "—", "[[note-3]]", "[[Note 7#head|label]]", "[[ספר]]", "\n", "\n\n", "  ",
];

function makeNote(i: number): IndexInput {
  const n = 5 + Math.floor(rnd() * 40);
  const words: string[] = [];
  for (let k = 0; k < n; k++) words.push(pick(WORDS));
  const name = pick(["note-" + i + ".md", "ספר.md", "Note 7.md", "ירושלים " + i + ".md"]);
  return { path: `${pick(["a", "b/c", "דף"])}/${i}-${name}`, name, content: words.join(" "), modified: Math.floor(rnd() * 1e6) };
}

const QUERIES = ["שלום", "ושלום", "בית", "הבית", "ספר", "צה\"ל", "ג'ירפה", "תל-אביב", "hello", "lumen", "it's", "\"quoted", "σοφια", "café", "2026", "1:", "-", "note", "zz", "", "  ", "ירושלים", "ל", "x)"];

function same(a: VaultIndex, b: ReferenceVaultIndex) {
  for (const q of QUERIES) {
    for (const limit of [5, 30, 1000]) expect(a.search(q, { limit }), `search ${JSON.stringify(q)} ${limit}`).toEqual(b.search(q, { limit }));
  }
  for (const t of ["note-3.md", "x/Note 7.md", "ספר.md"]) expect(a.backlinks(t)).toEqual(b.backlinks(t));
  expect(a.paths()).toEqual(b.paths());
}

describe("compact vault index (W2.22)", () => {
  it("returns the same results as the previous index through random edits", () => {
    for (const s of [1, 2, 3]) {
      seed = s;
      const a = new VaultIndex();
      const b = new ReferenceVaultIndex();
      const notes: IndexInput[] = [];
      for (let i = 0; i < 700; i++) notes.push(makeNote(i));
      for (const n of notes) {
        a.upsert(n);
        b.upsert(n);
      }
      same(a, b);
      for (let k = 0; k < 400; k++) {
        const r = rnd();
        if (r < 0.5) {
          const n = { ...pick(notes), content: makeNote(k).content, modified: k };
          a.upsert(n);
          b.upsert(n);
        } else if (r < 0.8) {
          const p = pick(notes).path;
          expect(a.remove(p)).toBe(b.remove(p));
        } else {
          const n = makeNote(10_000 + k);
          notes.push(n);
          a.upsert(n);
          b.upsert(n);
        }
        if (k % 100 === 0) same(a, b);
      }
      same(a, b);
      a.clear();
      b.clear();
      same(a, b);
    }
  });

  it("folds text exactly as before, faster", () => {
    seed = 9;
    const extra = ["\u0001", "\t", "Ω", "Σ", "ΑΣ ", "😀", "\uD800", "ß", "İ", "ﬁ", "\u05B0", "ך", "e\u0301", "\u1100\u1161", "\uFB2A", "\u00E9", "\u200F"];
    for (let k = 0; k < 2000; k++) {
      const s = Array.from({ length: 12 }, () => (rnd() < 0.3 ? pick(extra) : pick(WORDS))).join(rnd() < 0.5 ? " " : "");
      expect(foldForSearch(s)).toBe(referenceFold(s));
    }
  });

  it("never matches across two notes", () => {
    const a = new VaultIndex();
    for (let i = 0; i < 600; i++) a.upsert({ path: `n${i}.md`, name: `n${i}.md`, content: i % 2 ? "abc" : "def", modified: i });
    expect(a.search("cdef", { limit: 1000 })).toEqual([]);
    expect(a.search("abc", { limit: 1000 }).length).toBe(300);
  });

  it("keeps a query with the separator character from matching across notes", () => {
    const a = new VaultIndex();
    a.upsert({ path: "1.md", name: "1.md", content: "ab", modified: 1 });
    a.upsert({ path: "2.md", name: "2.md", content: "cd", modified: 2 });
    expect(a.search("b" + String.fromCharCode(0xffff) + "c").map((h) => h.path)).toEqual([]);
  });
});

describe("index snapshot (W2.22)", () => {
  it("round-trips and refuses another vault or a malformed snapshot", async () => {
    const { decodeSnapshot, encodeSnapshot } = await import("../storage/indexSnapshot");
    const files = [
      { path: "a.md", name: "a.md", modified: 5, content: "שלום" },
      { path: "b/c.md", name: "c.md", modified: 7, content: "x" },
    ];
    const enc = encodeSnapshot("opfs", files);
    // Review 14.11 S3: each note's UTF-8 size is kept with its mtime ("שלום" is 8 bytes).
    expect([...decodeSnapshot(enc, "opfs")!.values()]).toEqual(files.map((f, i) => ({ ...f, size: [8, 1][i] })));
    // Review 15 V1: a record written before the sizes is refused (its notes are read again once).
    const { sizes: _sizes, ...old } = enc;
    void _sizes;
    expect(decodeSnapshot(old, "opfs")).toBe(null);
    expect(decodeSnapshot({ ...enc, sizes: [1] }, "opfs")).toBe(null);
    expect(decodeSnapshot(enc, "folder")).toBe(null);
    expect(decodeSnapshot({ ...enc, v: 99 }, "opfs")).toBe(null);
    expect(decodeSnapshot({ ...enc, contents: ["only one"] }, "opfs")).toBe(null);
    expect(decodeSnapshot({ ...enc, modified: ["5", 7] }, "opfs")).toBe(null);
    expect(decodeSnapshot(undefined, "opfs")).toBe(null);
  });
});

describe("int8 embeddings (W2.22)", () => {
  it("score within 1% of float32 and pick the same best chunk", async () => {
    const { bestChunk, packVectors } = await import("../ai/semanticSearch");
    seed = 4;
    const vec = () => Float32Array.from({ length: 384 }, () => rnd() * 2 - 1);
    let same = 0;
    for (let t = 0; t < 200; t++) {
      const chunks = [vec(), vec(), vec(), vec()];
      const q = vec();
      const f = bestChunk(q, packVectors(chunks)!)!;
      const i = bestChunk(q, packVectors(chunks, { int8: true })!)!;
      expect(Math.abs(f.score - bestChunk(q, packVectors([chunks[f.index]], { int8: true })!)!.score)).toBeLessThan(0.01);
      if (f.index === i.index) same++;
    }
    expect(same).toBeGreaterThanOrEqual(190);
    const packed = packVectors([vec()], { int8: true })!;
    expect(packed.data).toBeInstanceOf(Int8Array);
  });
});

describe("text only in the index (W2.22)", () => {
  it("moves a note inside the index, keeping it searchable at its new path", () => {
    const a = new VaultIndex();
    a.upsert({ path: "a/x.md", name: "x.md", content: "ירושלים zebra [[y]]", modified: 3 });
    expect(a.move("a/x.md", "b/z.md", "z.md")).toBe(true);
    expect(a.move("missing.md", "c.md", "c.md")).toBe(false);
    expect(a.paths()).toEqual(["b/z.md"]);
    expect(a.search("zebra").map((h) => h.path)).toEqual(["b/z.md"]);
    expect(a.backlinks("y.md").map((h) => h.fromPath)).toEqual(["b/z.md"]);
    expect([...a.notes()]).toEqual([{ path: "b/z.md", name: "z.md", content: "ירושלים zebra [[y]]", modified: 3 }]);
  });

  it("restores unchanged notes from the snapshot in the index, and returns summaries without text", async () => {
    const { handleIndexRequest } = await import("../storage/vaultIndexLocal");
    const a = new VaultIndex();
    a.upsert({ path: "a.md", name: "a.md", content: "---\ntags: [x]\n---\nhello [[b]] #inline", modified: 5 });
    a.upsert({ path: "b.md", name: "b.md", content: "old", modified: 6 });
    expect(await handleIndexRequest(a, { id: 1, op: "snapshotSave", vault: "t" })).toMatchObject({ ok: true, result: 2 });
    const b = new VaultIndex();
    const res = (await handleIndexRequest(b, {
      id: 2,
      op: "snapshotRestore",
      vault: "t",
      listing: [
        { path: "a.md", name: "a.md", modified: 5 },
        { path: "b.md", name: "b.md", modified: 7 },
        { path: "c.md", name: "c.md", modified: 1 },
      ],
    })) as { ok: true; result: Record<string, unknown>[] };
    expect(res.result.map((r) => r.path)).toEqual(["a.md"]);
    expect(res.result[0]).toMatchObject({ wikiTargets: ["b"], frontmatter: "---\ntags: [x]\n---\n", chars: 37 });
    expect((res.result[0].meta as { tags: string[] }).tags.sort()).toEqual(["inline", "x"]);
    expect("content" in res.result[0]).toBe(false);
    expect(b.paths()).toEqual(["a.md"]);
    expect(b.search("hello").length).toBe(1);
    expect(((await handleIndexRequest(new VaultIndex(), { id: 3, op: "snapshotRestore", vault: "other", listing: [{ path: "a.md", name: "a.md", modified: 5 }] })) as { result: unknown[] }).result).toEqual([]);
  });

  it("summarizes a note for the main thread", async () => {
    const { summarize, MAX_FRONTMATTER } = await import("../storage/noteSummary");
    const s = summarize("---\ntitle: T\n---\nbody [[x|label]] #tag");
    expect(s).toMatchObject({ wikiTargets: ["x"], frontmatter: "---\ntitle: T\n---\n", chars: 38 });
    expect(s.meta).toEqual({ tags: ["tag"], props: { title: "T" } });
    expect(summarize("no frontmatter").frontmatter).toBe(null);
    expect(summarize(`---\n${"a: b\n".repeat(MAX_FRONTMATTER)}---\nx`).frontmatter).toBe(null);
  });
});
