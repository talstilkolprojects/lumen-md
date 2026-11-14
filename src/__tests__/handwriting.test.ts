/**
 * Plan W7.11: the held-out handwriting set's design, the pen's strokes as an
 * online recogniser takes them, the collection note, and the gate.
 */
import { describe, expect, it } from "vitest";
import { GATES, HELD_OUT_WRITERS, collectionSheet, LINES_PER_WRITER, PROMPTS, WRITERS, assignPrompts, exposed, inkSequence, itemsFromNote, publishLine, splitOf, type PathResult } from "../ink/handwriting";
import { roundPoint, toInsertion, type Ink } from "../ink/inkModel";

function stroke(x0: number, n: number): Ink["strokes"][number] {
  const points = [];
  for (let i = 0; i < n; i++) points.push(roundPoint(x0 - i * 3, 40 + Math.sin(i / 3) * 8, 0.3 + i / (3 * n)));
  return { points, size: 4, color: "#1f2937", simulated: false };
}
const ink = (id: string): Ink => ({ id, width: 400, height: 120, dir: "rtl", placement: "block", label: "כתב יד", strokes: [stroke(300, 12), stroke(200, 9)] });

describe("Hebrew handwriting (W7.11)", () => {
  it("300 lines from 20 writers; each prompt written by 5 writers; digits and English inside the lines", () => {
    expect(WRITERS * LINES_PER_WRITER).toBe(300);
    const count = new Array(PROMPTS.length).fill(0);
    const sets = new Set<string>();
    for (let w = 1; w <= WRITERS; w++) {
      const a = assignPrompts(w);
      expect(new Set(a).size, `writer ${w}`).toBe(LINES_PER_WRITER);
      sets.add(a.join());
      for (const p of a) count[p]++;
    }
    expect(sets.size).toBe(WRITERS);
    expect(new Set(count)).toEqual(new Set([5]));
    expect(PROMPTS.filter((p) => /\d/.test(p)).length).toBeGreaterThanOrEqual(30);
    expect(PROMPTS.filter((p) => /[A-Za-z]/.test(p)).length).toBeGreaterThanOrEqual(12);
    expect(() => assignPrompts(21)).toThrow();
  });

  it("held out by writer (W6.17): a quarter of the lines, never mixed with dev", () => {
    expect(HELD_OUT_WRITERS.length * LINES_PER_WRITER).toBe(75);
    expect([1, 15, 16, 20].map(splitOf)).toEqual(["dev", "dev", "heldout", "heldout"]);
  });

  it("the pen's strokes in writing order, scaled to height 1, pressure kept", () => {
    const seq = inkSequence(ink("a"));
    expect(seq.length).toBe(2);
    expect(seq[0][0][0]).toBeGreaterThan(seq[0][1][0]); // a Hebrew stroke runs right to left, and stays so
    const ys = seq.flat().map((p) => p[1]);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(1);
    expect(Math.abs(seq[0][0][2] - 0.3)).toBeLessThan(0.01);
    expect(inkSequence({ ...ink("b"), strokes: [] })).toEqual([]);
  });

  it("a writer's sheet comes back as items: one ink per heading; a heading without ink is listed", () => {
    const s = collectionSheet(3);
    const prompts = assignPrompts(3);
    expect(s).toContain("CC BY 4.0");
    expect([...s.matchAll(/^## (\d+)$/gm)].map((m) => Number(m[1]))).toEqual(prompts);
    // The writer draws under the first two headings only.
    let note = s;
    for (const p of prompts.slice(0, 2)) note = note.replace(`> ${PROMPTS[p]}\n`, `> ${PROMPTS[p]}\n\n${toInsertion(ink(`w3-${p}`)).trim()}\n`);
    const { items, missing } = itemsFromNote(3, note);
    expect(items.map((i) => [i.prompt, i.text, i.ink.strokes.length])).toEqual(prompts.slice(0, 2).map((p) => [p, PROMPTS[p], 2]));
    expect(missing).toEqual(prompts.slice(2));
  });

  it("a path is shown only under its bar on ≥ 50 held-out lines; the numbers are published either way", () => {
    const r = (path: "ink" | "image", cer: number, lines = 75): PathResult => ({ path, engine: "e", cer, lines, date: "2026-11-14" });
    expect(GATES).toEqual({ ink: 0.15, image: 0.2 });
    const e = exposed([r("image", 0.31), r("image", 0.19), r("ink", 0.16), r("image", 0.1, 20)]);
    expect(e.image?.cer).toBe(0.19);
    expect(e.ink).toBeNull();
    expect(publishLine(r("ink", 0.16))).toMatch(/CER 16\.00% on 75 held-out lines — does not meet the 15% bar \(not shown to users\)$/);
    expect(publishLine(r("image", 0.19))).toMatch(/meets the 20% bar$/);
  });
});
