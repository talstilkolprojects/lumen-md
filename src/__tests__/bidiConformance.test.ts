/**
 * W11.H1 — Unicode bidi conformance runner. The data rows here are the
 * SYNTHETIC fixture (fixtures/public-eval/*.synthetic.txt, labelled as such);
 * the real BidiCharacterTest.txt is downloaded and run by
 * `npm run eval:public -- run unicode-bidi` (owed: no network here).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { firstStrong, strongDirection, markdownLineDirection } from "../lib/bidiDirection";
import {
  parseBidiCharacterTest,
  parseBidiTest,
  runCharacterTest,
  lumenParagraphLevel,
  bidiJsEngine,
  BIDI_CONFORMANCE_MIN,
  REPRESENTATIVE,
  BIDI_CLASSES,
} from "../eval/public/adapters/bidi";

const fixture = (n: string) => readFileSync(`src/__tests__/fixtures/public-eval/${n}`, "utf8");

describe("UAX #9 P2: isolates are skipped when looking for the first strong character", () => {
  it("an RLI…PDI with Latin inside does not make a Hebrew line LTR", () => {
    // Before W11.H1 firstStrong returned "ltr" here (it saw the "a" inside the isolate).
    expect(firstStrong("⁧abc⁩ שלום")).toBe("rtl");
    expect(firstStrong("⁨abc⁩ שלום")).toBe("rtl");
    expect(firstStrong("⁦שלום⁩ hello")).toBe("ltr");
  });
  it("nested isolates, an unmatched PDI, and an initiator without a PDI", () => {
    expect(firstStrong("⁦⁧א⁩b⁩ ג")).toBe("rtl");
    expect(firstStrong("⁩abc")).toBe("ltr");
    expect(firstStrong("⁨abc")).toBeNull();
  });
  it("a Markdown line that starts with an isolated English citation is Hebrew", () => {
    expect(markdownLineDirection("⁨(Smith, 2020)⁩ כתב ש...")).toBe("rtl");
  });
  it("plain text is unchanged", () => {
    expect(firstStrong("123 abc")).toBe("ltr");
    expect(firstStrong("123 אבג")).toBe("rtl");
    expect(firstStrong("123 !?")).toBeNull();
  });
});

describe("BidiCharacterTest format", () => {
  const rows = parseBidiCharacterTest(fixture("bidi-character-test.synthetic.txt"));
  it("parses code points, direction, paragraph level, levels with x, and order", () => {
    expect(rows).toHaveLength(7);
    expect(rows[2]).toMatchObject({ cps: [0x2067, 0x61, 0x2069, 0x20, 0x5d0], dir: 2, paraLevel: 1, levels: [1, 4, 1, 1, 1], order: [4, 3, 2, 1, 0] });
    expect(parseBidiCharacterTest("202A 0061;0;0;x 0;1")[0].levels).toEqual([null, 0]);
  });
  it("rejects a malformed line instead of skipping it", () => {
    expect(() => parseBidiCharacterTest("0061;2;0")).toThrow(/5 fields/);
    expect(() => parseBidiCharacterTest("0061;3;0;0;0")).toThrow(/direction/);
  });
  it("Lumen's paragraph level matches every row of the synthetic fixture", () => {
    const rep = runCharacterTest(rows);
    expect(rep.checks).toEqual({ paragraphLevel: true, levels: null, order: null });
    expect(rep.failures.paragraphLevel.count).toBe(0);
    expect(rep.passed).toBe(7);
    expect(rep.rate).toBeGreaterThanOrEqual(BIDI_CONFORMANCE_MIN);
  });
  it("the runner fails when one rule of the strong table is changed on purpose", () => {
    // Mutation: the Hebrew block (U+0590–U+05FF) loses its strong-R class.
    const mutated = (cp: number) => (cp >= 0x590 && cp <= 0x5ff ? null : strongDirection(cp));
    const rep = runCharacterTest(rows, { strong: mutated });
    expect(rep.failures.paragraphLevel.count).toBeGreaterThan(0);
    expect(rep.failures.paragraphLevel.examples).toContain(rows[1].line);
    expect(rep.rate).toBeLessThan(BIDI_CONFORMANCE_MIN);
  });
  it("the paragraph level stops at the first paragraph separator (P1)", () => {
    expect(lumenParagraphLevel([0x31, 0x2029, 0x5d0], 2)).toBe(0);
    expect(lumenParagraphLevel([0x5d0, 0x2029, 0x61], 2)).toBe(1);
    expect(lumenParagraphLevel([0x5d0], 0)).toBe(0);
  });
});

describe("BidiTest format", () => {
  it("parses @Levels / @Reorder blocks and class sequences with their direction bitset", () => {
    const rows = parseBidiTest(fixture("bidi-test.synthetic.txt"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ classes: ["L"], dirs: 3, levels: [0], order: [0] });
    expect(rows[3]).toMatchObject({ classes: ["LRE", "L"], levels: [null, 0], order: [1] });
    expect(() => parseBidiTest("@Levels: 0\nXX; 1")).toThrow(/unknown class/);
  });
  it("every bidi class has a representative character", () => {
    for (const c of BIDI_CLASSES) expect(REPRESENTATIVE[c], c).toBeTypeOf("number");
  });
});

describe("bidi-js adapter (the UBA engine for levels and order)", () => {
  // A stand-in with bidi-js's API shape, to check the UTF-16 ↔ code point mapping only.
  const fake = {
    getEmbeddingLevels: (text: string) => ({ levels: Uint8Array.from(Array.from({ length: text.length }, (_, i) => (i < 2 ? 1 : 0))), paragraphs: [{ start: 0, end: text.length - 1, level: 1 }] }),
    getReorderedIndices: (text: string) => Array.from({ length: text.length }, (_, i) => text.length - 1 - i),
  };
  const engine = bidiJsEngine(fake, (cp) => cp === 0x202a);
  it("a supplementary character is one code point: its level is its first unit's, its order index is mapped back", () => {
    const cps = [0x10900, 0x61, 0x202a];
    expect(engine.levels(cps, null).levels).toEqual([1, 0, null]);
    expect(engine.order(cps, null)).toEqual([1, 0]);
    expect(engine.id).toBe("bidi-js@1.1.0");
  });
});
