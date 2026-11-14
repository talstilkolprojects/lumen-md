/**
 * Plan 5.2 acceptance on the retrieval golden set's dev split (7.1):
 * nDCG@10 on HeQ, against the search it replaces, and query time at
 * 10 000 notes. The test split and the owner's queries (15.11) are scored
 * by CI only (scripts/golden/evals/retrieval.mjs).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const files = new Map<string, string>();
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  listWorkspace: async () => [...files.keys()].map((path) => ({ path, name: path.split("/").pop()!, modified: 1 })),
  readWorkspaceFile: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT");
    return files.get(p)!;
  },
  basename: (p: string) => p.split("/").pop()!,
  isAssetName: () => false,
}));

import { Bm25Index } from "../search/bm25";
import { __resetWorkspaceIndex, searchWorkspace } from "../storage/workspaceIndex";
// @ts-expect-error the harness is plain JavaScript
import { ndcgAt, scoreWith } from "../../scripts/golden/evals/retrieval.mjs";

const heq = JSON.parse(readFileSync(join(__dirname, "../../eval/golden/retrieval/dev/heq.json"), "utf8"));
type Item = { id: string; query: string; relevant: string[]; sameArticle?: string[] };
const items: Item[] = heq.items.map((it: Item) => ({ ...it, part: "heq" }));
const corpus: Array<{ id: string; title: string; text: string }> = heq.corpus;

/**
 * nDCG@10 of the search this replaces (searchWorkspace on 9766f7e2: the
 * whole query as a substring of the note), measured on this dev split
 * with the same notes (one per paragraph, named after its article). It
 * finds nothing for a question: 0. Searched word by word, best words
 * summed (more than the dialog ever did): 0.670.
 */
const BASELINE = 0;

describe("BM25 on the HeQ dev split", () => {
  it("reaches nDCG@10 ≥ the old search + 10 points (and does not regress below 0.9)", () => {
    const { "ndcg@10.heq": heqScore } = scoreWith(Bm25Index, { items, corpus: { heq: corpus } });
    expect(heqScore).toBeGreaterThanOrEqual(BASELINE + 0.1);
    expect(heqScore).toBeGreaterThanOrEqual(0.9);
  });

  it("ranks the same way through searchWorkspace (the dialog and the agent tool)", async () => {
    __resetWorkspaceIndex();
    files.clear();
    const idOf = new Map<string, string>();
    for (const d of corpus) {
      const path = `heq/${d.title.replace(/[/\\]/g, "-")} ${d.id}.md`;
      files.set(path, d.text);
      idOf.set(path, d.id);
    }
    let sum = 0;
    for (const it of items) {
      const skip = new Set(it.sameArticle ?? []);
      const hits = await searchWorkspace(it.query, { limit: 10 + skip.size });
      sum += ndcgAt(hits.map((h) => idOf.get(h.path)!).filter((id) => !skip.has(id)), it.relevant, 10);
    }
    expect(sum / items.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe("searchWorkspace ranking", () => {
  const vault = async (notes: Record<string, string>) => {
    __resetWorkspaceIndex();
    files.clear();
    for (const [path, text] of Object.entries(notes)) files.set(path, text);
  };

  it("a note with the exact phrase is not pruned before its phrase bonus (review: #232)", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    await vault({
      "n1.md": "beta one alpha",
      "n2.md": "beta two alpha",
      "n3.md": `${filler} alpha beta ${filler}`,
    });
    const [top] = await searchWorkspace("alpha beta", { limit: 1 });
    expect(top.path).toBe("n3.md");
    expect(top.snippet).toContain("alpha beta");
  });

  it("finds a word that is still being typed, as the old substring search did", async () => {
    await vault({ "a.md": "Notes about the garden", "b.md": "גינה ופרחים בחצר", "c.md": "nothing here" });
    expect((await searchWorkspace("gard")).map((h) => h.path)).toEqual(["a.md"]);
    expect((await searchWorkspace("about the gar")).map((h) => h.path)).toEqual(["a.md"]);
    expect((await searchWorkspace("גינ")).map((h) => h.path)).toEqual(["b.md"]);
    // A finished word still ranks a note that has it exactly above one that only extends it.
    await vault({ "x.md": "the gardener came", "y.md": "the garden grows" });
    expect((await searchWorkspace("garden"))[0].path).toBe("y.md");
  });
});

describe("index freshness", () => {
  it("a search during a long first sync still sees a note saved meanwhile (review: #232)", async () => {
    __resetWorkspaceIndex();
    files.clear();
    for (let i = 0; i < 3000; i++) files.set(`v/${String(i).padStart(4, "0")}.md`, corpus[i % corpus.length].text);
    const first = [...files.keys()][0];
    const a = searchWorkspace("עוגייה"); // reads the vault, starts the first BM25 pass (it yields)
    // Let the pass get going (past the first note), then save that note.
    const pass = new Promise((r) => setTimeout(r, 50));
    await pass;
    files.set(first, "טקסט חדש על אוקיינוס השקט");
    window.dispatchEvent(new CustomEvent("lumen-workspace-changed", { detail: { kind: "content", paths: [first] } }));
    const b = await searchWorkspace("אוקיינוס");
    await a;
    expect(b.map((h) => h.path)).toContain(first);
  }, 120_000);
});

describe("10 000 notes", () => {
  it("answers a query in under 100 ms (index already built)", async () => {
    __resetWorkspaceIndex();
    files.clear();
    for (let i = 0; i < 10_000; i++) {
      const d = corpus[i % corpus.length];
      files.set(`vault/${String(i).padStart(5, "0")} ${d.title.replace(/[/\\]/g, "-")}.md`, `${d.text}\nהערה ${i}`);
    }
    await searchWorkspace("חימום"); // the first search reads the vault and builds the index
    const raw = new Bm25Index();
    for (const [path, text] of files) raw.set(path, text, path);
    const queries = items.map((it) => it.query);
    let t = performance.now();
    for (const q of queries) raw.search(q, { limit: 30 });
    const indexMs = (performance.now() - t) / queries.length;
    t = performance.now();
    for (const q of queries) await searchWorkspace(q, { limit: 40 });
    const searchMs = (performance.now() - t) / queries.length;
    expect(indexMs).toBeLessThan(100);
    expect(searchMs).toBeLessThan(100);
  }, 120_000);

  it("re-indexes only the saved note, not the vault", async () => {
    const spy = vi.spyOn(Bm25Index.prototype, "set");
    const path = [...files.keys()][42];
    files.set(path, "פסקה חדשה לגמרי על כוכב הלכת זוהרה");
    window.dispatchEvent(new CustomEvent("lumen-workspace-changed", { detail: { kind: "content", paths: [path] } }));
    const hits = await searchWorkspace("זוהרה");
    expect(hits[0].path).toBe(path);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(path);
    spy.mockRestore();
  }, 60_000);
});
