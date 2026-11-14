// W6.8 (W10.F2): the preview gate's time is calculated from a build's receipt
// and held to GATE_BUDGET_MIN. The receipts below are synthetic (made up for
// the arithmetic); a real one comes from reports/vercel-build.json of a build.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error untyped .mjs
import { estimateGate } from "../../scripts/gate-estimate.mjs";
// @ts-expect-error untyped .mjs
import { PREVIEW_GATES } from "../../scripts/vercel-build.mjs";
// @ts-expect-error untyped .mjs
import { GATE_BUDGET_MIN } from "../../scripts/test-tiers.mjs";

const ROOT = resolve(__dirname, "../..");
const receiptOf = (secondsEach: number, extra: Record<string, unknown> = {}) => ({
  gates: (PREVIEW_GATES as string[]).map((gate) => ({ gate, seconds: secondsEach, ok: true })),
  ...extra,
});

describe("scripts/gate-estimate.mjs", () => {
  it("passes a receipt whose preview gates add up to less than the budget", () => {
    const n = (PREVIEW_GATES as string[]).length;
    const v = estimateGate(receiptOf(((GATE_BUDGET_MIN - 1) * 60) / n));
    expect(v.status).toBe("ok");
    expect(v.minutes).toBeLessThan(GATE_BUDGET_MIN);
    expect(v.missing).toEqual([]);
  });

  it("fails one over the budget, by the gates' sum or by the build's own total", () => {
    const n = (PREVIEW_GATES as string[]).length;
    expect(estimateGate(receiptOf(((GATE_BUDGET_MIN + 1) * 60) / n)).status).toBe("over");
    expect(estimateGate(receiptOf(1, { totalMinutes: GATE_BUDGET_MIN + 0.5 })).status).toBe("over");
  });

  it("never passes a receipt that lacks a preview gate, or no receipt at all", () => {
    const r = receiptOf(1);
    r.gates = r.gates.filter((g: { gate: string }) => g.gate !== "mutation");
    const v = estimateGate(r);
    expect(v.status).toBe("unknown");
    expect(v.missing).toEqual(["mutation"]);
    expect(estimateGate(null).status).toBe("unknown");
    expect(estimateGate({}).status).toBe("unknown");
  });

  it("reads the fields scripts/vercel-build.mjs writes into its receipt", () => {
    const src = readFileSync(resolve(ROOT, "scripts/vercel-build.mjs"), "utf8");
    expect(src).toMatch(/receipt\.gates\.push\(\{ gate, seconds: Number\(secs\), ok: r\.status === 0 \}\)/);
    expect(src).toMatch(/receipt\.totalMinutes = /);
  });
});
