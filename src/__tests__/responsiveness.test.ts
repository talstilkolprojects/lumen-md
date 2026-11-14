// @vitest-environment node
/**
 * Plan W6.45: the responsiveness gate (+10 % per environment fails), the
 * lumen-metric receipt the area board scores, and the probes' arithmetic.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGETS,
  PERF_PLATFORMS,
  boardMetrics,
  budgetMisses,
  compareRuns,
  flatten,
  metricReceipt,
  // @ts-expect-error -- plain .mjs script, no types
} from "../../scripts/perf/responsivenessLib.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { gate, perfBrowserstackYml } from "../../scripts/perf/responsiveness.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { check, seal } from "../../scripts/nightly/receipt.mjs";
import { interactionsFromEntries, quantile } from "../../e2e/perf/probes";

type Run = {
  format: string;
  env: string;
  device: string;
  cpuSlowdown: number;
  scored: boolean;
  relatedPanel?: boolean;
  inpBudget?: number;
  editors: Record<string, { inpP75: number | null; k2pP95: Record<string, number> }>;
};

const run = (over: Partial<Run> = {}, scale = 1): Run => ({
  format: "lumen-responsiveness",
  env: "desktop-chromium",
  device: "Desktop Chrome",
  cpuSlowdown: 1,
  scored: true,
  relatedPanel: true,
  inpBudget: 100,
  editors: {
    source: { inpP75: 40 * scale, k2pP95: { "50KB": 8 * scale, "2MB": 20 * scale } },
    wysiwyg: { inpP75: 56 * scale, k2pP95: { "50KB": 10 * scale, "2MB": 25 * scale } },
  },
  ...over,
});

describe("the +10 % gate", () => {
  it("an artificial 10 % regression fails; 9 % passes", () => {
    expect(compareRuns(run(), run({}, 1.1)).ok).toBe(false);
    expect(compareRuns(run(), run({}, 1.1)).rows.every((r: { regressed: boolean }) => r.regressed)).toBe(true);
    expect(compareRuns(run(), run({}, 1.09)).ok).toBe(true);
    expect(compareRuns(run(), run({}, 0.5)).ok).toBe(true);
  });

  it("one editor's metric regressing is enough", () => {
    const worse = run();
    worse.editors.wysiwyg.k2pP95["2MB"] = 25 * 1.12;
    const c = compareRuns(run(), worse);
    expect(c.ok).toBe(false);
    expect(c.rows.filter((r: { regressed: boolean }) => r.regressed).map((r: { metric: string }) => r.metric)).toEqual(["wysiwyg.k2pP95.2MB"]);
  });

  it("noise below 1 ms is measured against 1 ms", () => {
    const base = run();
    base.editors.source.k2pP95["50KB"] = 0.3;
    const next = run();
    next.editors.source.k2pP95["50KB"] = 0.9;
    expect(compareRuns(base, next).ok).toBe(true);
  });

  it("a metric of the baseline missing from the run fails; environments are never mixed", () => {
    const next = run();
    next.editors.source.inpP75 = null;
    expect(compareRuns(run(), next)).toMatchObject({ ok: false, missing: ["source.inpP75"] });
    expect(() => compareRuns(run(), run({ env: "mid-phone-emulated" }))).toThrow(/baseline is for/);
  });

  it("a run with the related-notes panel is never compared with a baseline without it (W2.2)", () => {
    expect(() => compareRuns(run({ relatedPanel: false }), run())).toThrow(/related-notes panel/);
    expect(() => compareRuns(run(), run({ relatedPanel: false }))).toThrow(/re-baseline/);
    const dir = mkdtempSync(join(tmpdir(), "lumen-resp-"));
    gate({ runs: [run({ relatedPanel: false })], baselines: dir });
    const g = gate({ runs: [run(), run({ env: "mid-phone-emulated" })], baselines: dir });
    expect(g.ok).toBe(false);
    expect(g.lines.join("\n")).toMatch(/✗ desktop-chromium: baseline did not have the related-notes panel open/);
    expect(g.lines.join("\n")).toMatch(/mid-phone-emulated: no baseline yet/);
  });

  it("gate(): the first run becomes the baseline, the next one is compared with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-resp-"));
    const first = gate({ runs: [run()], baselines: dir });
    expect(first.ok).toBe(true);
    expect(existsSync(join(dir, "desktop-chromium.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "desktop-chromium.json"), "utf8")).editors.source.inpP75).toBe(40);
    expect(gate({ runs: [run({}, 1.05)], baselines: dir }).ok).toBe(true);
    const bad = gate({ runs: [run({}, 1.1)], baselines: dir });
    expect(bad.ok).toBe(false);
    expect(bad.lines.join("\n")).toMatch(/✗ desktop-chromium source\.inpP75 .* \+10\.0 %/);
    expect(gate({ runs: [], baselines: dir }).ok).toBe(false);
  });
});

describe("budgets (the plan's acceptance)", () => {
  it("desktop INP < 100, phone < 200, keypress → paint < 16 / 33 ms", () => {
    expect(BUDGETS).toEqual({ inpDesktop: 100, inpPhone: 200, k2p50KB: 16, k2p2MB: 33 });
    expect(budgetMisses(run())).toEqual([]);
    expect(budgetMisses(run({}, 2))).toEqual([
      "source keypress→paint p95 50 KB 16.0 ms ≥ 16",
      "source keypress→paint p95 2 MB 40.0 ms ≥ 33",
      "wysiwyg INP p75 112.0 ms ≥ 100",
      "wysiwyg keypress→paint p95 50 KB 20.0 ms ≥ 16",
      "wysiwyg keypress→paint p95 2 MB 50.0 ms ≥ 33",
    ]);
    expect(budgetMisses(run({ env: "mid-phone-emulated", cpuSlowdown: 4, inpBudget: 200 }, 2)).some((m: string) => m.includes("INP"))).toBe(false);
  });
});

describe("the lumen-metric receipt", () => {
  const phone = run({ env: "real-device-google-pixel-8", device: "Google Pixel 8", inpBudget: 200 }, 2);
  const harness = run({ env: "offline-harness-desktop", device: "headless Chromium, probes on a plain editor", scored: false }, 0.1);

  it("the worse editor counts; desktop and phone feed their own board ids; unscored runs feed none", () => {
    expect(boardMetrics([run()])).toEqual({ "perf.inp-p75-ms": 56, "perf.key2paint-p95-50kb-ms": 10, "perf.key2paint-p95-2mb-ms": 25 });
    const m = boardMetrics([run(), phone, harness]);
    expect(m["perf.inp-p75-ms"]).toBe(56);
    expect(m["perf.inp-p75-mid-phone-ms"]).toBe(112);
    expect(m["perf.key2paint-p95-2mb-ms"]).toBe(50);
    expect(m["perf.unscored.offline-harness-desktop.inp-p75-ms"]).toBe(5.6);
    expect(boardMetrics([harness])["perf.inp-p75-ms"]).toBeUndefined();
    // Without the related-notes panel (a build before W2.2) a run proves no board number.
    const bare = boardMetrics([run({ relatedPanel: false })]);
    expect(bare["perf.inp-p75-ms"]).toBeUndefined();
    expect(bare["perf.unscored.desktop-chromium.inp-p75-ms"]).toBe(56);
  });

  it("is the board's format, and seals and verifies with the nightly receipt code", () => {
    const r = metricReceipt([run(), phone], { sha: "a".repeat(40), command: "npm run perf:responsiveness", measuredAt: "2026-11-12T20:00:00.000Z" });
    expect(r).toMatchObject({ format: "lumen-metric", version: 1, kind: "metric", commit: { sha: "a".repeat(40) }, measuredAt: "2026-11-12T20:00:00.000Z" });
    expect(Object.keys(r.metrics)).toContain("perf.inp-p75-ms");
    expect(r.environments.map((e: { env: string }) => e.env)).toEqual(["desktop-chromium", "real-device-google-pixel-8"]);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sealed = seal(r, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(check(sealed, pub).ok).toBe(true);
    expect(check({ ...sealed, metrics: { ...sealed.metrics, "perf.inp-p75-ms": 1 } }, pub).ok).toBe(false);
  });

  it("flatten names every gated number", () => {
    expect(Object.keys(flatten(run()))).toEqual([
      "source.inpP75",
      "source.k2pP95.50KB",
      "source.k2pP95.2MB",
      "wysiwyg.inpP75",
      "wysiwyg.k2pP95.50KB",
      "wysiwyg.k2pP95.2MB",
    ]);
  });
});

describe("real phones on BrowserStack", () => {
  it("one Android and one iPhone, both by device name", () => {
    expect(PERF_PLATFORMS.map((p: { os: string }) => p.os)).toEqual(["android", "ios"]);
    const yml = perfBrowserstackYml({ build: "b" });
    expect(yml).toContain('deviceName: "Google Pixel 8"');
    expect(yml).toContain('deviceName: "iPhone 16"');
    expect(yml).toContain("browserstackLocal: true");
  });
});

describe("the probes' arithmetic", () => {
  it("nearest-rank quantiles", () => {
    expect(quantile([], 0.75)).toBe(0);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3);
    expect(quantile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
  });
  it("each step takes its longest entry; an unreported step counts as 16 ms", () => {
    const entries = [
      { id: 1, start: 5, duration: 24, name: "keydown" },
      { id: 1, start: 6, duration: 40, name: "keyup" },
      { id: 2, start: 25, duration: 120, name: "click" },
    ];
    expect(interactionsFromEntries(["a", "b", "c"], [0, 10, 20], entries)).toEqual([
      { name: "a", ms: 40 },
      { name: "b", ms: 16 },
      { name: "c", ms: 120 },
    ]);
  });
});
