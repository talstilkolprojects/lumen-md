/**
 * Plan W3.3 acceptance: scheduling identical to ts-fsrs on 50 golden
 * scenarios. The expected results come from ts-fsrs itself
 * (`npm install --no-save ts-fsrs@4 && node scripts/fsrs-golden.mjs` writes
 * src/__tests__/fixtures/fsrs-golden.json). Until that file is committed the
 * comparison is skipped — reported as skipped, never as passed.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_W, fsrs, newCard, type Card, type Rating } from "../srs/fsrs";
import {
  simulate,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/fsrs-scenarios.mjs";

const GOLDEN = resolve(__dirname, "fixtures", "fsrs-golden.json");
type Rec = { at: string; rating: Rating; state: string; due: string; stability: number; difficulty: number; scheduledDays: number };
const golden = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as { w: number[] | null; scenarios: Array<{ id: string; steps: unknown[]; records: Rec[] }> }) : null;
const run = golden ? describe : describe.skip;

run("FSRS-5 vs ts-fsrs: 50 golden scenarios (W3.3)", () => {
  it("uses the same default weights", () => {
    if (golden!.w) expect(golden!.w).toEqual([...DEFAULT_W]);
    expect(golden!.scenarios).toHaveLength(50);
  });
  const f = fsrs();
  for (const s of golden?.scenarios ?? []) {
    it(`${s.id}: every review gives the same state, due time, stability and difficulty`, () => {
      const ours = simulate(s as never, { create: (now: Date) => newCard(now), next: (c: Card, g: Rating, now: Date) => f.next(c, g, now), read: (c: Card) => c }) as Rec[];
      expect(ours.map((r) => [r.at, r.state, r.due, r.scheduledDays])).toEqual(s.records.map((r) => [r.at, r.state, r.due, r.scheduledDays]));
      for (const [i, r] of ours.entries()) {
        expect(Math.abs(r.stability - s.records[i].stability), `${s.id} step ${i + 1} stability`).toBeLessThan(1e-4);
        expect(Math.abs(r.difficulty - s.records[i].difficulty), `${s.id} step ${i + 1} difficulty`).toBeLessThan(1e-4);
      }
    });
  }
});
