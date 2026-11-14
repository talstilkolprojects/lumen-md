// @vitest-environment node
import { describe, it, expect } from "vitest";

describe("englishSpell — acceptance on the spell-en dev split (plan 6.10)", () => {
  it("recall ≥ 90% on the injected errors, false positives ≤ 3% of the clean words", async () => {
    // @ts-expect-error — plain .mjs module without types
    const { score, devItems, TARGETS } = await import("../../scripts/golden/evals/spell-en.mjs");
    const s = await score({ items: devItems() });
    expect(s.detection_recall).toBeGreaterThanOrEqual(TARGETS.detection_recall);
    expect(s.fp_word_rate).toBeLessThanOrEqual(TARGETS.fp_word_rate);
  }, 60_000);
});
