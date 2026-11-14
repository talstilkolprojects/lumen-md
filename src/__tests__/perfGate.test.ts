/**
 * Plan 8.3 — the performance gate (npm run perf:gate): one load's metrics
 * from the browser's entries, Lighthouse's median-run, the thresholds and
 * the config. The browser run itself is scripts/perf-gate.mjs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs module without type declarations
import { COLLECTOR, evaluate, failed, markdown, medianRun, metricsOf } from "../../scripts/lib/perfGate.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { parseArgs } from "../../scripts/perf-gate.mjs";

const ROOT = resolve(__dirname, "../..");

describe("metrics of one load", () => {
  it("TBT is the part over 50 ms of each long task after FCP; TTI ends with the last one", () => {
    const m = metricsOf({ fcp: 100, lcp: 400, cls: 0.02, longTasks: [[20, 200], [300, 120], [500, 40]] }, { domContentLoaded: 250, ready: 450 });
    // [20,220] counts from FCP: 120 − 50 = 70; [300,420]: 70; the 40 ms task is not long enough to block.
    expect(m).toEqual({ fcp: 100, lcp: 400, cls: 0.02, tbt: 140, tti: 540, ready: 450 });
  });

  it("no long tasks: TTI is FCP or DOMContentLoaded, TBT 0; no FCP: no TTI", () => {
    expect(metricsOf({ fcp: 90, lcp: 120, cls: 0, longTasks: [] }, { domContentLoaded: 150 })).toMatchObject({ tti: 150, tbt: 0 });
    expect(metricsOf({ fcp: null, lcp: null, cls: 0, longTasks: [] }).tti).toBeNull();
  });

  it("the collector observes paint, LCP, layout shifts (without input) and long tasks, buffered", () => {
    for (const t of ["paint", "largest-contentful-paint", "layout-shift", "longtask"]) expect(COLLECTOR).toContain(`on("${t}"`);
    expect(COLLECTOR).toContain("buffered: true");
    expect(COLLECTOR).toContain("hadRecentInput");
  });
});

describe("median run", () => {
  it("picks the one real run closest to the median FCP and TTI (not a mix, not the best)", () => {
    const runs = [
      { fcp: 900, tti: 3000, lcp: 1 },
      { fcp: 1000, tti: 3200, lcp: 2 },
      { fcp: 1500, tti: 5000, lcp: 3 },
      { fcp: 800, tti: 2600, lcp: 4 },
      { fcp: 1100, tti: 3400, lcp: 5 },
    ];
    expect(medianRun(runs).lcp).toBe(2);
    expect(medianRun([{ fcp: null, tti: null }])).toBeNull();
  });
});

describe("thresholds", () => {
  const assert = { fcp: { error: 1200, target: 1000 }, lcp: { error: 3500, target: 2500 }, tbt: { warn: 250 } };

  it("error fails the gate, warn and an unmet target do not", () => {
    const ok = evaluate({ fcp: 1083, lcp: 2400, tbt: 400 }, assert);
    expect(ok.find((r: { metric: string }) => r.metric === "fcp")).toMatchObject({ ok: true, metTarget: false, level: "error" });
    expect(ok.find((r: { metric: string }) => r.metric === "tbt")).toMatchObject({ ok: false, level: "warn" });
    expect(failed(ok)).toBe(false);
    expect(failed(evaluate({ fcp: 1300, lcp: 2400, tbt: 0 }, assert))).toBe(true);
    // A metric that was not measured cannot pass.
    expect(failed(evaluate({ fcp: null, lcp: 2400 }, assert))).toBe(true);
  });

  it("the summary is Markdown with the failing row marked", () => {
    const results = evaluate({ fcp: 1300, lcp: 2400, tbt: 10 }, assert);
    const md = markdown([{ name: "desktop", median: {}, runs: [{ fcp: 1300, lcp: 2400, tti: 2000 }], results }], { url: "http://127.0.0.1:4173", runs: 1 });
    expect(md).toContain("| FCP | 1300 ms | 1200 ms | error | 1000 ms | **FAIL** |");
    expect(md).toContain("| LCP | 2400 ms | 3500 ms | error | 2500 ms | ok |");
  });
});

describe("config and command line", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "perf-gate.config.json"), "utf8"));

  it("5 runs, median-run, desktop + mobile, the runner-level error thresholds of 15.16 (20)/(21)", () => {
    expect(config.runs).toBe(5);
    expect(config.aggregation).toBe("median-run");
    expect(Object.keys(config.profiles)).toEqual(["desktop", "mobile"]);
    expect(config.profiles.desktop.assert.lcp).toEqual({ error: 3500, target: 2500 });
    expect(config.profiles.desktop.assert.fcp).toEqual({ error: 1200, target: 1000 });
    expect(config.profiles.mobile.cpuSlowdown).toBe(4);
  });

  it("parses options", () => {
    expect(parseArgs([])).toMatchObject({ url: undefined, profiles: undefined, runs: undefined, port: 4173, quietMs: 3000 });
    expect(parseArgs(["--url", "https://x.example", "--profiles", "desktop", "--runs", "3"])).toMatchObject({ url: "https://x.example", profiles: ["desktop"], runs: 3 });
    expect(() => parseArgs(["--runs", "0"])).toThrow(/positive/);
  });

  it("is an npm script; LHCI stays a separate, optional command", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["perf:gate"]).toBe("node scripts/perf-gate.mjs");
  });
});
