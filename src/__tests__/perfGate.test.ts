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

  it("5 runs, median-run, desktop + mobile, every limit an error at the plan's target (W10.E9)", () => {
    expect(config.runs).toBe(5);
    expect(config.aggregation).toBe("median-run");
    expect(Object.keys(config.profiles)).toEqual(["desktop", "mobile"]);
    expect(config.profiles.desktop.assert.lcp).toEqual({ error: 2500, target: 2500 });
    expect(config.profiles.desktop.assert.fcp).toEqual({ error: 1000, target: 1000 });
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

/**
 * W10.E9 — no threshold looser than the plan (8.3, 0.11; research R5.3).
 * The plan's numbers live here, in the test: loosening a config file makes
 * this red, tightening it never does. INP is measured by
 * e2e/inp-budget.spec.ts (navigation-mode Lighthouse cannot measure it).
 */
describe("the thresholds are the plan's, or stricter", () => {
  const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));
  /** Plan 8.3: performance ≥ 0.9, LCP ≤ 2.5 s, 5 runs, median run, desktop + mobile, as errors. */
  const PLAN = {
    "lighthouserc.json": { preset: "desktop", minScore: { "categories:performance": 0.9, "categories:accessibility": 0.95 }, max: { "first-contentful-paint": 1000, "largest-contentful-paint": 2500, "total-blocking-time": 200, "cumulative-layout-shift": 0.1 } },
    "lighthouserc.mobile.json": { preset: null, minScore: { "categories:performance": 0.8, "categories:accessibility": 0.95 }, max: { "first-contentful-paint": 1800, "largest-contentful-paint": 2500, "total-blocking-time": 300, "cumulative-layout-shift": 0.1 } },
  } as const;
  const PERF_PLAN: Record<string, Record<string, number>> = {
    desktop: { fcp: 1000, lcp: 2500, tbt: 200, cls: 0.1 },
    mobile: { fcp: 1800, lcp: 2500, tti: 3500, tbt: 300, cls: 0.1 },
  };
  /** Audits Lighthouse 13 removed or replaced with insights (developer.chrome.com/blog/lighthouse-13-0). */
  const GONE_IN_LH13 = [
    "uses-http2", "uses-responsive-images", "uses-rel-preconnect", "uses-rel-preload", "offscreen-images", "font-size", "font-display",
    "render-blocking-resources", "uses-long-cache-ttl", "modern-image-formats", "uses-optimized-images", "efficient-animated-content",
    "layout-shifts", "redirects", "server-response-time", "uses-text-compression", "dom-size", "duplicated-javascript",
    "work-during-interaction", "prioritize-lcp-image", "lcp-lazy-loaded", "largest-contentful-paint-element", "legacy-javascript",
    "critical-request-chains", "third-party-summary", "viewport", "first-meaningful-paint", "no-document-write", "preload-fonts",
    "third-party-facades", "uses-passive-event-listeners",
  ];
  type Assertion = [string, { minScore?: number; maxNumericValue?: number; aggregationMethod?: string }];

  for (const [file, plan] of Object.entries(PLAN)) {
    it(`${file}: 5 runs, every assertion an error at the plan's limit or stricter, median run, reports on disk`, () => {
      const rc = json(file).ci;
      expect(rc.collect.numberOfRuns).toBe(5);
      expect(rc.collect.settings.preset ?? null).toBe(plan.preset);
      if (!plan.preset) expect(rc.collect.settings.formFactor).toBe("mobile");
      const a = rc.assert.assertions as Record<string, Assertion>;
      for (const [k, min] of Object.entries(plan.minScore)) {
        expect(a[k]?.[0], k).toBe("error");
        expect(a[k][1].minScore, k).toBeGreaterThanOrEqual(min);
      }
      for (const [k, max] of Object.entries(plan.max)) {
        expect(a[k]?.[0], k).toBe("error");
        expect(a[k][1].maxNumericValue, k).toBeLessThanOrEqual(max);
      }
      for (const [k, v] of Object.entries(a)) expect(v[1]?.aggregationMethod, k).toBe("median-run");
      // Reports stay local: never temporary-public-storage.
      expect(rc.upload.target).toBe("filesystem");
      expect(rc.upload.outputDir).toMatch(/^reports\/lh\//);
      // Lighthouse 13 audit ids only.
      const ids = [...Object.keys(a), ...(rc.collect.settings.skipAudits ?? []), ...(rc.collect.settings.onlyAudits ?? [])];
      for (const id of ids) expect(GONE_IN_LH13, id).not.toContain(id);
    });
  }

  it("perf-gate.config.json: every planned limit an error, on the phone too", () => {
    const c = json("perf-gate.config.json");
    for (const [profile, limits] of Object.entries(PERF_PLAN)) {
      for (const [metric, max] of Object.entries(limits)) {
        const a = c.profiles[profile].assert[metric];
        expect(a?.error, `${profile} ${metric}`).toBeDefined();
        expect(a.error, `${profile} ${metric}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("Lighthouse CI is pinned to a release with Lighthouse 13 (0.16.x), in CI and in the npm script", () => {
    const pkg = json("package.json");
    expect(pkg.scripts.lighthouse).toContain("@lhci/cli@0.16.1 autorun --config=./lighthouserc.json");
    expect(pkg.scripts.lighthouse).toContain("--config=./lighthouserc.mobile.json");
    const pipeline = readFileSync(join(ROOT, ".buildkite/pipeline.yml"), "utf8");
    expect(pipeline).toContain("npx -y @lhci/cli@0.16.1 autorun --config=./lighthouserc.json");
    expect(pipeline).toContain("npx -y @lhci/cli@0.16.1 autorun --config=./lighthouserc.mobile.json");
    expect(pipeline).not.toContain("temporary-public-storage");
  });
});


/** W10.E10 — Lighthouse and the performance gate on every PR, not only on main or a label. */
describe("on every PR", () => {
  it("the Buildkite Lighthouse step (and its ci.yml source) has no condition, and keeps its reports as artifacts", async () => {
    const YAML = (await import("yaml")).default;
    const pipeline = YAML.parse(readFileSync(join(ROOT, ".buildkite/pipeline.yml"), "utf8")) as { steps: Array<{ key?: string; if?: string; artifact_paths?: string[] }> };
    const step = pipeline.steps.find((s) => s.key === "lighthouse");
    expect(step).toBeDefined();
    expect(step!.if).toBeUndefined();
    expect(step!.artifact_paths).toContain("reports/lh/**/*");
    // ci.yml repeats `env:` on its Build step; GitHub keeps the last one (as scripts/buildkite/pipeline.mjs parses it).
    const ci = YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"), { uniqueKeys: false }) as { jobs: Record<string, { if?: string }> };
    expect(ci.jobs.lighthouse.if).toBeUndefined();
  });

  it("a Vercel preview build runs perf:gate after e2e, with its report", async () => {
    // @ts-expect-error — plain .mjs module without type declarations
    const { GATES, GATE_EXTRA, PREVIEW_GATES, PRODUCTION_GATES } = await import("../../scripts/vercel-build.mjs");
    expect(PREVIEW_GATES.indexOf("perf:gate")).toBe(PREVIEW_GATES.indexOf("e2e") + 1);
    expect(PRODUCTION_GATES).not.toContain("perf:gate");
    expect(GATES["perf:gate"]).toEqual(["run", "-s", "perf:gate"]);
    expect(GATE_EXTRA["perf:gate"]).toEqual(["--", "--out", "reports/perf-gate.md", "--json", "reports/perf-gate.json"]);
  });
});
