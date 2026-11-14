/**
 * Plan 6.7 — image search by text: delta indexing (6.7.4), ranking, the
 * Hebrew query route through local translation (6.7.2), and the golden-set
 * metric. The model itself is not loaded here (the converted SigLIP is not
 * downloadable before 15.9); its quality is the eval's job.
 */
import { describe, it, expect, vi } from "vitest";
import { HEBREW_DIRECT, isImagePath, planDelta, queryVector, rankImages, retrievalMetrics, updateImageIndex, type ImageIndex } from "../ai/imageSearch";
// @ts-expect-error — plain .mjs helper without types
import { metrics, ranksOf } from "../../scripts/golden/evals/image-search.mjs";

const unit = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

describe("planDelta / updateImageIndex (6.7.4)", () => {
  const entries = [
    { path: "a.png", size: 10, modified: 1 },
    { path: "notes/b.jpg", size: 20, modified: 2 },
    { path: "c.md", size: 5, modified: 3 },
  ];

  it("embeds only images, and only new or changed ones", () => {
    const index: ImageIndex = { model: "m", images: [{ path: "a.png", size: 10, modified: 1, vector: [1, 0] }, { path: "gone.png", size: 1, modified: 1, vector: [0, 1] }] };
    const { keep, embed } = planDelta(index, [...entries, { path: "notes/b.jpg", size: 20, modified: 2 }].slice(0, 3), "m");
    expect(keep.map((i) => i.path)).toEqual(["a.png"]);
    expect(embed.map((e) => e.path)).toEqual(["notes/b.jpg"]);
    // A changed file is embedded again; another model starts over.
    expect(planDelta(index, [{ path: "a.png", size: 11, modified: 1 }], "m").embed).toHaveLength(1);
    expect(planDelta(index, [{ path: "a.png", size: 10, modified: 1 }], "other").embed).toHaveLength(1);
  });

  it("keeps vectors across runs: the second run embeds nothing", async () => {
    let stored: ImageIndex | null = null;
    const embedImages = vi.fn(async (blobs: Blob[]) => blobs.map((_, i) => unit([1, i])));
    const deps = {
      list: async () => entries,
      read: async () => new Blob(["x"]),
      embedImages,
      load: async () => stored,
      save: vi.fn(async (i: ImageIndex) => {
        stored = i;
      }),
      model: "m",
    };
    const first = await updateImageIndex(deps);
    expect(first.embedded).toBe(2);
    expect(first.index.images.map((i) => i.path).sort()).toEqual(["a.png", "notes/b.jpg"]);
    const second = await updateImageIndex(deps);
    expect(second.embedded).toBe(0);
    expect(embedImages).toHaveBeenCalledTimes(1);
    expect(deps.save).toHaveBeenCalledTimes(1);
  });

  it("drops a deleted image from the index", async () => {
    let stored: ImageIndex | null = { model: "m", images: [{ path: "a.png", size: 10, modified: 1, vector: [1, 0] }, { path: "x.png", size: 1, modified: 1, vector: [0, 1] }] };
    const r = await updateImageIndex({ list: async () => [entries[0]], read: async () => new Blob([]), embedImages: async () => [], load: async () => stored, save: async (i) => void (stored = i), model: "m" });
    expect(r.index.images.map((i) => i.path)).toEqual(["a.png"]);
    expect(stored?.images).toHaveLength(1);
  });

  it("stops between batches when aborted", async () => {
    const ac = new AbortController();
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `${i}.png`, size: 1, modified: 1 }));
    const embedImages = vi.fn(async (b: Blob[]) => {
      ac.abort();
      return b.map(() => [1]);
    });
    await expect(updateImageIndex({ list: async () => many, read: async () => new Blob([]), embedImages, load: async () => null, save: async () => undefined, batch: 4, signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(embedImages).toHaveBeenCalledTimes(1);
  });

  it("knows image files by extension", () => {
    expect(["a.PNG", "b.jpeg", "c.webp", "d.gif"].every(isImagePath)).toBe(true);
    expect(["a.md", "b.pdf", "png"].some(isImagePath)).toBe(false);
  });
});

describe("rankImages", () => {
  it("orders by cosine similarity, ties by path", () => {
    const index: ImageIndex = { model: "m", images: [{ path: "b", size: 0, modified: 0, vector: unit([1, 0]) }, { path: "a", size: 0, modified: 0, vector: unit([1, 0]) }, { path: "c", size: 0, modified: 0, vector: unit([0, 1]) }] };
    expect(rankImages(index, unit([1, 0.1])).map((h) => h.path)).toEqual(["a", "b", "c"]);
    expect(rankImages(index, unit([0, 1]), 1).map((h) => h.path)).toEqual(["c"]);
  });
});

describe("queryVector (6.7.2)", () => {
  it("translates a Hebrew query to English first while Hebrew is not measured", async () => {
    expect(HEBREW_DIRECT).toBeNull();
    const embedText = vi.fn(async (t: string[]) => [[t[0].length]]);
    const toEnglish = vi.fn(async () => "a red bicycle");
    const r = await queryVector("אופניים אדומים", { embedText, toEnglish });
    expect(r).toMatchObject({ text: "a red bicycle", translated: true });
    expect(embedText).toHaveBeenCalledWith(["a red bicycle"], undefined);
  });

  it("uses the Hebrew query as written when no local layer can translate, or when Hebrew is direct", async () => {
    const embedText = vi.fn(async () => [[1]]);
    expect(await queryVector("אופניים", { embedText, toEnglish: async () => null })).toMatchObject({ text: "אופניים", translated: false });
    const toEnglish = vi.fn(async () => "bike");
    expect(await queryVector("אופניים", { embedText, toEnglish, hebrewDirect: true })).toMatchObject({ text: "אופניים", translated: false });
    expect(toEnglish).not.toHaveBeenCalled();
    expect(await queryVector("a bike", { embedText, toEnglish })).toMatchObject({ text: "a bike", translated: false });
    expect(toEnglish).not.toHaveBeenCalled();
  });

  it("falls back to the original when translation throws", async () => {
    const r = await queryVector("חתול", { embedText: async () => [[1]], toEnglish: async () => { throw new Error("no model"); } });
    expect(r).toMatchObject({ text: "חתול", translated: false });
  });
});

describe("retrieval metrics (the golden set's metric)", () => {
  it("computes recall@1, recall@5 and nDCG@10, missing items counted as misses", () => {
    const m = retrievalMetrics([1, 2, 6, 11, null], 5);
    expect(m.recallAt1).toBeCloseTo(1 / 5);
    expect(m.recallAtK).toBeCloseTo(2 / 5);
    expect(m.ndcg10).toBeCloseTo((1 + 1 / Math.log2(3) + 1 / Math.log2(7)) / 5);
  });

  it("the eval harness ranks with the same rule and agrees on the numbers", () => {
    const imgs = [unit([1, 0, 0]), unit([0, 1, 0]), unit([0, 0, 1])];
    const qs = [unit([1, 0.1, 0]), unit([0.9, 1, 0]), unit([1, 0, 0.2])];
    const ranks = ranksOf(qs, imgs, [0, 1, 2]);
    expect(ranks).toEqual([1, 1, 2]);
    const a = metrics(ranks, 5);
    const b = retrievalMetrics(ranks, 5);
    expect(a.recallAt1).toBeCloseTo(b.recallAt1);
    expect(a.recallAt5).toBeCloseTo(b.recallAtK);
    expect(a.ndcg10).toBeCloseTo(b.ndcg10);
  });
});
