// @vitest-environment node
/** scripts/perf/profile-startup.mjs — TTI / TBT over long tasks (Codex P1 on #259). */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import { ttiAndTbt } from "../../scripts/perf/tti.mjs";

describe("ttiAndTbt", () => {
  it("is interactive at FCP when the first long task starts 5 s or more after it, and that task is not blocking time", () => {
    const r = ttiAndTbt([[6500, 400]], 1000, 11000);
    expect(r).toEqual({ tti: 1000, reached: true, tbt: 0, longTasks: 0 });
  });

  it("ends at the last long task before a quiet window, counting the tasks before it", () => {
    const r = ttiAndTbt([[1200, 300], [1600, 100], [2000, 150], [9000, 80]], 1000, 15000);
    expect(r.tti).toBe(2150);
    expect(r.reached).toBe(true);
    expect(r.tbt).toBe(250 + 50 + 100);
    expect(r.longTasks).toBe(3);
  });

  it("is not reached when no quiet window fits, and then every task counts", () => {
    const r = ttiAndTbt([[1100, 200], [4000, 200]], 1000, 7000);
    expect(r.reached).toBe(false);
    expect(r.tbt).toBe(150 + 150);
  });

  it("with no long task at all, a window shorter than 5 s is not reached and a longer one is", () => {
    expect(ttiAndTbt([], 1000, 4000).reached).toBe(false);
    expect(ttiAndTbt([], 1000, 7000)).toEqual({ tti: 1000, reached: true, tbt: 0, longTasks: 0 });
  });
});
