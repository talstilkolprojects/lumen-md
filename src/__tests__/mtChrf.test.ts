/**
 * The translation harness (plan 6.4): chrF as sacreBLEU computes it, and a
 * harness that reports what it could not measure instead of a number.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs scripts without type declarations
import { chrF, scoreAll, LAYERS, PAIRS } from "../../scripts/golden/evals/mt.mjs";
// @ts-expect-error — plain .mjs scripts without type declarations
import { score } from "../../scripts/golden/evals/mt-he-en.mjs";

describe("chrF (sacreBLEU chrF2)", () => {
  it("is 100 for an identical corpus and 0 for a disjoint one", () => {
    expect(chrF(["The cat sat.", "שלום עולם"], ["The cat sat.", "שלום עולם"])).toBeCloseTo(100, 6);
    expect(chrF(["abc"], ["xyz"])).toBe(0);
    expect(chrF([""], ["abc"])).toBe(0);
  });

  it("matches the hand computation: averaged precision and recall over the orders both sides have, F with β = 2", () => {
    // ref "cat", hyp "cat sat" → whitespace removed: "cat" vs "catsat".
    // n=1: match 3 / hyp 6 / ref 3; n=2: 2 / 5 / 2; n=3: 1 / 4 / 1; orders 4–6: the reference has none.
    const prec = (3 / 6 + 2 / 5 + 1 / 4) / 3;
    const rec = 1;
    const f2 = (100 * 5 * prec * rec) / (4 * prec + rec);
    expect(chrF(["cat sat"], ["cat"])).toBeCloseTo(f2, 9);
    expect(f2).toBeCloseTo(75.66, 1);
  });

  it("is corpus-level: statistics are summed over sentences before the ratio", () => {
    // Two sentences: one perfect, one empty hypothesis → not the mean of 100 and 0.
    const corpus = chrF(["abcdef", ""], ["abcdef", "abcdef"]);
    expect(corpus).toBeGreaterThan(0);
    expect(corpus).toBeLessThan(100);
    // Each order: match = hyp = half of ref → precision 1, recall 0.5 → F2 = 5·1·0.5 / (4·1 + 0.5) = 55.6
    expect(corpus).toBeCloseTo(55.5556, 3);
    expect(() => chrF(["a"], ["a", "b"])).toThrow(/1 hypotheses for 2/);
  });
});

describe("the harness in an environment without models", () => {
  const items = [{ he: "שלום", en: "hello" }];

  it("measures nothing here and says why for every layer and pair", async () => {
    const { chrF: scores, reasons } = await scoreAll(items, { layers: LAYERS });
    for (const layer of LAYERS) {
      for (const p of PAIRS) {
        const k = `${p.source}-${p.target}`;
        expect(scores[layer][k], `${layer} ${k}`).toBeNull();
        expect(reasons[layer][k], `${layer} ${k}`).toMatch(/not downloadable|Hugging Face|browser-only|model endpoint/);
      }
    }
  }, 60_000);

  it("the set harness reports layers_measured = 0 instead of a number", async () => {
    const s = await score({ items });
    expect(s).toEqual({ items: 1, layers_measured: 0 });
  }, 60_000);
});
