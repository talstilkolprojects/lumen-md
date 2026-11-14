/**
 * Plan W1.22: the local responsiveness gate fails on a 10 % regression.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs script without type declarations
import { compare, gatedMetrics, REGRESSION } from "../../scripts/perf/inp-gate.mjs";

const run = (inp: number, k50: number, k2: number) => ({ inpP75: inp, keyToPaintP95: { "50KB": k50, "2MB": k2 } });

describe("scripts/perf/inp-gate.mjs", () => {
  it("gates the three numbers W1.22 budgets", () => {
    expect(Object.keys(gatedMetrics(run(1, 2, 3)))).toEqual(["INP p75", "keypress→paint p95 (50KB)", "keypress→paint p95 (2MB)"]);
    expect(REGRESSION).toBe(0.1);
  });

  it("a 10 % slower metric fails, 9 % does not, faster never does", () => {
    const rows = compare(run(80, 10, 20), run(88, 10.9, 15));
    expect(rows.map((r: { regressed: boolean }) => r.regressed)).toEqual([true, false, false]);
  });

  it("noise under a millisecond at the floor is not a regression", () => {
    const [, k50] = compare(run(50, 0.2, 20), run(50, 0.9, 20));
    expect(k50.regressed).toBe(false);
  });

  it("skips a metric one of the runs lacks", () => {
    expect(compare({ inpP75: 50 }, run(50, 1, 1))).toHaveLength(1);
  });
});
