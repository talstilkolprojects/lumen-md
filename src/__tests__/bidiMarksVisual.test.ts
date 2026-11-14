/**
 * Plan W5.4 acceptance: cleaning unneeded direction marks does not change
 * the visual order of a line. Each line is laid out with bidi-js (a full
 * UAX #9 implementation, a dev dependency since 9.7) before and after
 * cleaning; the characters the reader sees must come out in the same
 * order, at the same embedding level parity (which decides mirroring).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bidiFactory from "bidi-js";
import { markdownLineDirection } from "../lib/bidiDirection";
import { BIDI_CONTROLS, fixBidiText } from "../lib/bidiMarks";
import { goldenBidiLines, withNoiseMarks } from "./fixtures/goldenBidiLines";

const bidi = bidiFactory();

/** The visible characters of `line` in display order, each with its level's parity. */
function visual(line: string): string {
  const dir = markdownLineDirection(line) ?? "ltr";
  const levels = bidi.getEmbeddingLevels(line, dir);
  const order = Array.from({ length: line.length }, (_, i) => i);
  for (const [start, end] of bidi.getReorderSegments(line, levels)) {
    const seg = order.slice(start, end + 1).reverse();
    order.splice(start, seg.length, ...seg);
  }
  return order
    .filter((i) => !BIDI_CONTROLS.has(line.charCodeAt(i)))
    .map((i) => `${line[i]}${levels.levels[i] & 1 ? "R" : "L"}`)
    .join("");
}

const FIXTURE: Array<{ id: string; line: string }> = JSON.parse(readFileSync(join(__dirname, "fixtures", "bidi-marks-lines.json"), "utf8")).items;

describe("cleaning keeps the visual order", () => {
  it("the 30 lines of the 9.7 golden set, with unneeded marks added and cleaned: 30/30", () => {
    let same = 0;
    const lines = goldenBidiLines();
    for (const line of lines) {
      const noisy = withNoiseMarks(line);
      const cleaned = fixBidiText(noisy);
      if (visual(cleaned) === visual(noisy) && visual(cleaned) === visual(line)) same++;
      else console.log("changed", JSON.stringify(line));
    }
    expect(same).toBe(30);
  });

  it("the 30 marked lines: cleaning changes what is stored, never what is seen", () => {
    for (const f of FIXTURE) expect({ id: f.id, v: visual(fixBidiText(f.line, { brackets: false })) }).toEqual({ id: f.id, v: visual(f.line) });
  });
});
