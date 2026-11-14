/**
 * W4.21 — the screen-reader journey's data and matching (sr/journey.ts),
 * which the Guidepup specs use on a Mac or Windows host.
 */
import { describe, it, expect } from "vitest";
import { TASKS, missing, normalizeSpoken, resultRow } from "../../sr/journey";

describe("screen-reader journey", () => {
  it("has the 10 protocol tasks, numbered in order, each expecting Hebrew or a role", () => {
    expect(TASKS.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const t of TASKS) expect(t.expect.length).toBeGreaterThan(0);
  });

  it("matches spoken text across spacing, direction marks and either reader's wording", () => {
    const heading = TASKS.find((t) => t.id === 4)!;
    expect(missing(heading, ["כותרת  רמה 1", "‏תוכנית‏"])).toEqual([]);
    expect(missing(heading, ["heading level 1, תוכנית"])).toEqual([]);
    expect(missing(heading, ["תוכנית"])).toEqual(["כותרת רמה 1 / כותרת 1 / heading level 1"]);
    expect(normalizeSpoken(" a \n b ")).toBe("a b");
  });

  it("writes a row for the protocol's results table", () => {
    const row = resultRow("2026-11-12", "0.1.0", "NVDA / Windows", [
      { id: 1, missing: [] },
      { id: 2, missing: ["דילוג לתוכן הראשי"] },
    ]);
    expect(row).toBe("| 2026-11-12 | 0.1.0 | NVDA / Windows (Guidepup) | 1/2 (1) | 2: דילוג לתוכן הראשי |");
  });
});
