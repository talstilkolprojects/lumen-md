// @vitest-environment node
/**
 * Plan W10.B8 (audit W5.3): recall needs a human-labelled set.
 * scripts/grammar/eval.mjs scores the real checker on one, refuses a
 * generated set (the rule-coverage probe), and says "not measured" while
 * no set exists. The tiny set below is a test fixture written here, not
 * a measurement: it only checks the arithmetic.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hebrewGrammar } from "../ai/hebrewGrammar";
// @ts-expect-error plain JavaScript
import { DEFAULT_SET, scoreLabelled, validateSet } from "../../scripts/grammar/eval.mjs";

const probe = JSON.parse(readFileSync("eval/probes/hebrew-grammar.json", "utf8"));
const cli = (args: string[]) => spawnSync(process.execPath, ["scripts/grammar/eval.mjs", ...args], { encoding: "utf8" });

describe("scripts/grammar/eval.mjs (W10.B8)", () => {
  it("refuses the generated probe as a recall set", () => {
    const problems = validateSet(probe) as string[];
    expect(problems.some((p) => /origin must be "real"/.test(p))).toBe(true);
    expect(problems.some((p) => /labelledBy must be "human"/.test(p))).toBe(true);
  });

  it("counts sentence-level tp / fp / fn / tn and span recall with the real checker", () => {
    const fixture = {
      origin: "real",
      labelledBy: "human",
      items: [
        { id: "t1", text: "יש לי שלוש ילדים.", hasError: true, spans: [{ offset: 6, length: 4 }] },
        { id: "t2", text: "יש לי שלושה ילדים.", hasError: false },
        { id: "t3", text: "קנינו שתי ספרים בשוק.", flawed: true },
        { id: "t4", text: "הספר מונח על השולחן.", hasError: false },
      ],
    };
    expect(validateSet(fixture)).toEqual([]);
    const found = (t: string) => hebrewGrammar(t);
    // The checker's own view of each sentence, so the expected counts follow from it.
    const pred = fixture.items.map((it) => found(it.text).length > 0);
    expect(pred).toEqual([true, false, true, false]);
    const r = scoreLabelled(found, fixture);
    expect(r).toMatchObject({ n: 4, tp: 2, fp: 0, fn: 0, tn: 2, precision: 1, recall: 1, f1: 1 });
    expect(r.spans).toEqual({ n: 1, found: 1, recall: 1 });
    // A miss and a false alarm move the numbers.
    const r2 = scoreLabelled(found, { ...fixture, items: [{ text: "הספר מונח על השולחן.", hasError: true }, { text: "יש לי שלוש ילדים.", hasError: false }] });
    expect(r2).toMatchObject({ tp: 0, fp: 1, fn: 1, tn: 0, precision: 0, recall: 0 });
  });

  it("with no set, it measures nothing and says so (exit 3)", () => {
    expect(DEFAULT_SET).toBe("eval/golden/grammar-human/set.json");
    const r = cli(["--set", "eval/golden/grammar-human/does-not-exist.json"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/recall and precision are NOT measured/);
  });

  it("a set that is not real and human-labelled is refused (exit 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "grammar-eval-"));
    try {
      const f = join(dir, "set.json");
      writeFileSync(f, JSON.stringify(probe));
      const r = cli(["--set", f]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/a generated set measures rule coverage, not recall/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
