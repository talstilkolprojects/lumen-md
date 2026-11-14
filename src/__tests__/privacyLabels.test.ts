/**
 * Plan W2.24: the store privacy labels (store/privacy-labels.json) match what
 * the report can show. Every ledger category that can leave the device is
 * disclosed as an optional feature, the crash reporter is disclosed with its
 * condition, and "data not collected" holds only while every published
 * local-only audit passed with 0 non-local requests.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain ESM script module, no types
import { readAudits } from "../../scripts/privacy/publish.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

interface Labels {
  format: string;
  default: { dataLeavesDevice: boolean };
  apple: { tracking: boolean; dataNotCollected: boolean; dataTypes: Array<{ category: string; type: string; linkedToUser: boolean; usedForTracking: boolean; condition: string }> };
  google: { dataCollected: boolean; dataShared: boolean; conditionalCollection: Array<{ type: string; optional: boolean; condition: string }> };
  optionalFeatures: Array<{ feature: string; ledgerCategory: string | null; sends: string; turnedOnBy: string }>;
}
const labels = JSON.parse(read("store/privacy-labels.json")) as Labels;

/** The ledger's categories, from its type. */
function ledgerCategories(): string[] {
  const m = /export type LedgerCategory = ([^;]+);/.exec(read("src/ai/privacyLedger.ts"));
  return [...(m?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map((x) => x[1]);
}

describe("store privacy labels", () => {
  it("disclose every ledger category that can leave the device, and name only real ones", () => {
    const cats = ledgerCategories();
    expect(cats.length).toBeGreaterThan(5);
    const disclosed = new Set(labels.optionalFeatures.map((f) => f.ledgerCategory).filter((c): c is string => c !== null));
    for (const c of cats.filter((c) => c !== "local-ai")) expect(disclosed.has(c), c).toBe(true);
    for (const c of disclosed) expect(cats).toContain(c);
    for (const f of labels.optionalFeatures) expect(f.sends.length > 0 && f.turnedOnBy.length > 0, f.feature).toBe(true);
  });

  it("disclose the crash reporter with its condition, on both stores", () => {
    expect(read("src/lib/telemetry.ts")).toMatch(/VITE_SENTRY_DSN/);
    const apple = labels.apple.dataTypes.find((d) => d.type === "Crash Data");
    expect(apple).toMatchObject({ category: "Diagnostics", linkedToUser: false, usedForTracking: false });
    expect(apple!.condition).toMatch(/VITE_SENTRY_DSN/);
    expect(labels.google.conditionalCollection.some((c) => /Crash logs/.test(c.type) && c.optional && /VITE_SENTRY_DSN/.test(c.condition))).toBe(true);
    expect(labels.apple.tracking).toBe(false);
  });

  it("claim nothing leaves by default only while every published audit passed with 0 non-local requests", () => {
    expect(labels.default.dataLeavesDevice).toBe(false);
    expect(labels.apple.dataNotCollected && !labels.google.dataCollected && !labels.google.dataShared).toBe(true);
    for (const { file, audit } of readAudits(root) as Array<{ file: string; audit: { result: string; policy: string; observers: Array<{ observedNonLocal: string[]; ledgerNonLocal: string[] }> } }>) {
      expect(audit.result, file).toBe("pass");
      expect(audit.policy, file).toBe("local-only");
      for (const o of audit.observers) expect([...o.observedNonLocal, ...o.ledgerNonLocal], file).toEqual([]);
    }
  });
});
