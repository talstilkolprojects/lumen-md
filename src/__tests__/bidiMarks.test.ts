/**
 * Plan W5.4: invisible direction controls — found, told apart (harmless /
 * Trojan Source), cleaned without changing what the reader sees, and
 * reversed brackets fixed.
 *
 * The visual order itself (UAX #9 reordering before and after cleaning)
 * is checked with bidi-js in bidiMarksVisual.test.ts and in real browsers
 * in e2e/bidi-marks.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownLineDirection } from "../lib/bidiDirection";
import { BIDI_CONTROLS, applyEdits, bidiRisks, findBidiControls, fixBidi, fixBidiText, hasBidiRisk, removeRiskyEdits, reversedBrackets } from "../lib/bidiMarks";
import { goldenBidiLines, withNoiseMarks } from "./fixtures/goldenBidiLines";

interface MarkedLine {
  id: string;
  line: string;
  marks: string[];
  risks: string[];
  clean: string;
  why: string;
}

const FIXTURE: MarkedLine[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "bidi-marks-lines.json"), "utf8")).items;

describe("finding direction controls (30 golden lines)", () => {
  it("has 30 lines, each with at least one control", () => {
    expect(FIXTURE.length).toBe(30);
    for (const f of FIXTURE) expect(f.marks.length).toBeGreaterThan(0);
  });

  it("finds every control, by name and in order: 30/30", () => {
    let right = 0;
    for (const f of FIXTURE) {
      const got = findBidiControls(f.line).map((c) => c.control.name);
      if (JSON.stringify(got) === JSON.stringify(f.marks)) right++;
      else console.log("missed", f.id, got, f.marks);
    }
    expect(right).toBe(30);
  });

  it("knows all twelve controls", () => {
    expect([...BIDI_CONTROLS.values()].map((c) => c.name).sort()).toEqual(["ALM", "FSI", "LRE", "LRI", "LRM", "LRO", "PDF", "PDI", "RLE", "RLI", "RLM", "RLO"]);
  });

  it("flags Trojan Source — overrides and controls left open — and nothing else", () => {
    for (const f of FIXTURE) {
      expect({ id: f.id, risks: bidiRisks(f.line).map((r) => r.reason) }).toEqual({ id: f.id, risks: f.risks });
      expect(hasBidiRisk(f.line)).toBe(f.risks.length > 0);
    }
    expect(hasBidiRisk("שלום לכולם")).toBe(false);
  });

  it("pairs per line: an isolate opened on one line and closed on the next is still open", () => {
    expect(bidiRisks("א \u2067ב\n\u2069 ג").map((r) => r.control.name)).toEqual(["RLI"]);
  });

  it("removing the risks makes the text display in its stored order", () => {
    for (const f of FIXTURE.filter((x) => x.risks.length)) {
      const safe = applyEdits(f.line, removeRiskyEdits(f.line));
      expect(hasBidiRisk(safe)).toBe(false);
      expect(/[\u202d\u202e]/.test(safe)).toBe(false);
    }
    // A harmless isolate stays.
    const ok = "הקישור \u2066https://example.com/a\u2069 עובד \u202euser\u202c";
    expect(applyEdits(ok, removeRiskyEdits(ok))).toBe("הקישור \u2066https://example.com/a\u2069 עובד user");
  });
});

describe("cleaning unneeded controls", () => {
  it("each golden line cleans to its expected form", () => {
    for (const f of FIXTURE) expect({ id: f.id, why: f.why, got: fixBidiText(f.line, { brackets: false }) }).toEqual({ id: f.id, why: f.why, got: f.clean });
  });

  it("never touches overrides or open embeddings", () => {
    for (const f of FIXTURE.filter((x) => x.risks.length)) expect(bidiRisks(fixBidiText(f.line)).length).toBe(f.risks.length);
  });

  it("cleaning twice changes nothing more", () => {
    for (const f of FIXTURE) {
      const once = fixBidiText(f.line);
      expect(fixBidiText(once)).toBe(once);
    }
  });

  it("leaves fenced code alone", () => {
    const doc = "\u200fשלום\n```js\nconst a = '\u200fשלום';\n```\n\u200fשלום";
    expect(fixBidiText(doc)).toBe("שלום\n```js\nconst a = '\u200fשלום';\n```\nשלום");
  });

  it("returns one ordered, non-overlapping set of edits (one undo step)", () => {
    const doc = FIXTURE.map((f) => f.line).join("\n") + "\n)שלום(";
    const { edits, removed, swapped } = fixBidi(doc);
    for (let i = 1; i < edits.length; i++) expect(edits[i].from).toBeGreaterThanOrEqual(edits[i - 1].to);
    expect(removed).toBeGreaterThan(10);
    expect(swapped).toBe(1);
  });

  it("the 9.7 golden lines keep their direction, with and without extra marks", () => {
    const lines = goldenBidiLines();
    expect(lines.length).toBe(30);
    for (const line of lines) {
      expect(fixBidiText(line)).toBe(line); // nothing to clean, no reversed brackets
      // Unneeded marks in front of every word: cleaning takes them all out again.
      const noisy = withNoiseMarks(line);
      expect(markdownLineDirection(fixBidiText(noisy))).toBe(markdownLineDirection(line));
    }
  });
});

describe("reversed brackets", () => {
  const fix = (s: string) => fixBidiText(s);
  it("swaps brackets typed backwards in a Hebrew line", () => {
    expect(fix(")שלום(")).toBe("(שלום)");
    expect(fix("ראו ]1[ ו-)2(")).toBe("ראו [1] ו-(2)");
    expect(fix("הפגישה }מחר{")).toBe("הפגישה {מחר}");
  });
  it("leaves balanced, unswappable and left-to-right lines alone", () => {
    for (const s of ["(שלום)", "שלום :)", "1) פריט", "- [ ] משימה", "[קישור](https://example.com/a)", ")hello(", "f(x) = )y(", "שלום \\)כן\\("]) expect(fix(s)).toBe(s);
  });
  it("skips code spans", () => {
    expect(reversedBrackets("קוד `)x(` כאן")).toEqual([]);
  });
});
