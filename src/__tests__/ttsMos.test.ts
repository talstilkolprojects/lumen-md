/**
 * Plan W2.6 — the read-aloud listening test: MOS ≥ 3.8 over ≥ 5 raters who
 * scored all 20 golden sentences (scripts/lib/tts-mos.mjs).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mos,
  parseRatings,
  sheet,
  validateRatings,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/tts-mos.mjs";

const golden = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "eval", "listening", "tts-he.json"), "utf8")) as { license: string; sentences: Array<{ id: string; text: string }> };
const ids = golden.sentences.map((s) => s.id);
const RATERS = ["r1", "r2", "r3", "r4", "r5"];
const filled = (score: (rater: number, i: number) => number) => ["rater,sentence,score", ...RATERS.flatMap((r, ri) => ids.map((id, i) => `${r},${id},${score(ri, i)}`))].join("\n");

describe("listening test (W2.6)", () => {
  it("has 20 Hebrew golden sentences under CC0", () => {
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(golden.license).toBe("CC0-1.0");
    expect(golden.sentences.every((s) => /[א-ת]/.test(s.text))).toBe(true);
  });

  it("the blank sheet has a row per rater and sentence, and is not yet valid", () => {
    const csv = sheet(ids, RATERS);
    expect(csv.split("\n").filter(Boolean)).toHaveLength(1 + 5 * 20);
    expect(validateRatings(parseRatings(csv), ids)[0]).toBe("line 2: score must be a whole number 1–5");
  });

  it("MOS, interval and verdict", () => {
    const rows = parseRatings(filled((_r, i) => (i % 2 ? 4 : 5)));
    expect(validateRatings(rows, ids)).toEqual([]);
    const r = mos(rows);
    expect(r).toMatchObject({ mos: 4.5, n: 100, raters: 5, pass: true, target: 3.8 });
    expect(r.ci95[0]).toBeLessThan(4.5);
    expect(r.perSentence.s01).toBe(5);
    expect(mos(parseRatings(filled(() => 3))).pass).toBe(false);
  });

  it("rejects too few raters, a missing or duplicate score, and out-of-range values", () => {
    const four = parseRatings(["rater,sentence,score", ...RATERS.slice(0, 4).flatMap((r) => ids.map((id) => `${r},${id},4`))].join("\n"));
    expect(validateRatings(four, ids)).toContain("4 raters; the test needs at least 5");
    const rows = parseRatings(filled(() => 4) + "\nr1,s01,4\nr9,s99,7");
    const p = validateRatings(rows, ids);
    expect(p).toContain("line 102: r1 scored s01 twice");
    expect(p).toContain('line 103: unknown sentence "s99"');
    expect(p).toContain("line 103: score must be a whole number 1–5");
    expect(p.some((x: string) => x.startsWith("r9 did not score 20"))).toBe(true);
  });
});
