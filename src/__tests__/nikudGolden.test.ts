// @vitest-environment node
/**
 * Plan 6.3 acceptance on the nikud dev split, with the real Nakdimon model —
 * when its file is on this machine (NAKDIMON_ONNX, or models/nakdimon/
 * Nakdimon.onnx from a model-convert run). The file is not in the repo, so
 * without it this is skipped and the PR says "not measured".
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
// @ts-expect-error — plain .mjs module without types
import { devItems, modelPath, score } from "../../scripts/golden/evals/nikud.mjs";

const have = existsSync(modelPath());

describe.skipIf(!have)("nikud — Nakdimon on the dev split (plan 6.3)", () => {
  it("skeleton 100%; modern word accuracy reported, classical separately", async () => {
    const items = devItems();
    const s = await score({ items });
    expect(s.skeleton_ok).toBe(1);
    expect(s.benyehuda_word_acc).toBeGreaterThan(0);
    if (items.some((x: { part: string }) => x.part === "nakdimon")) expect(s.nakdimon_word_acc).toBeGreaterThanOrEqual(0.9);
  }, 120_000);
});
