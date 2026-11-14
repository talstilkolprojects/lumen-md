/**
 * Unit tests for BM25+ search engine.
 *
 * Run with: npx vitest run
 */

import { describe, it, expect } from "vitest";
import { buildBM25Index, bm25Search, tokenize } from "../ai/neuralSearch";

describe("BM25+ Search", () => {
  const docs = [
    { path: "react.md", content: "React is a JavaScript library for building user interfaces. React uses a virtual DOM for fast rendering." },
    { path: "vue.md", content: "Vue is a progressive JavaScript framework for building UIs. Vue has a template-based syntax." },
    { path: "cooking.md", content: "How to bake a chocolate cake with butter and sugar. Preheat the oven to 350°F." },
    { path: "typescript.md", content: "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript." },
  ];

  it("builds an index", () => {
    const index = buildBM25Index(docs);
    expect(index.docs.length).toBe(4);
    expect(index.N).toBe(4);
    expect(index.df.size).toBeGreaterThan(0);
  });

  it("ranks relevant documents higher", () => {
    const index = buildBM25Index(docs);
    const results = bm25Search("JavaScript framework", index, 4);
    expect(results.length).toBeGreaterThan(0);
    // JavaScript-related docs should rank higher than cooking
    const cookingIdx = results.findIndex((r) => r.path === "cooking.md");
    const reactIdx = results.findIndex((r) => r.path === "react.md");
    if (cookingIdx >= 0 && reactIdx >= 0) {
      expect(reactIdx).toBeLessThan(cookingIdx);
    }
  });

  it("handles empty query", () => {
    const index = buildBM25Index(docs);
    const results = bm25Search("", index, 4);
    expect(results.length).toBe(0);
  });

  it("handles query with no matches", () => {
    const index = buildBM25Index(docs);
    const results = bm25Search("xylophone quantum entanglement", index, 4);
    // May return empty or low-score results
    expect(results.length).toBeLessThanOrEqual(4);
  });

  it("respects topK limit", () => {
    const index = buildBM25Index(docs);
    const results = bm25Search("JavaScript", index, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("tokenize with niqqud", () => {
  it("keeps pointed Hebrew words whole", () => {
    expect(tokenize("שָׁלוֹם עוֹלָם")).toEqual(["שלום", "עולם"]);
    expect(tokenize("בְּרֵאשִׁית בָּרָא")).toEqual(tokenize("בראשית ברא"));
  });
  it("still splits on a maqaf and keeps Latin accents", () => {
    expect(tokenize("בֵּית־סֵפֶר")).toEqual(["בית", "ספר"]);
    expect(tokenize("Café crème")).toEqual(["café", "crème"]);
  });
  it("finds a plain query in a pointed note", () => {
    const idx = buildBM25Index([
      { path: "a.md", content: "שָׁלוֹם עוֹלָם וּמַה שְּׁלוֹמְךָ" },
      { path: "b.md", content: "רשימת קניות לשבוע הבא" },
    ]);
    expect(bm25Search("שלום", idx)[0]?.path).toBe("a.md");
  });
});

