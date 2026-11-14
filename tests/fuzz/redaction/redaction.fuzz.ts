/**
 * The nightly redaction fuzz (plan W8.8). Not in the main suite: it runs with
 * `npm run fuzz:redaction` (scripts/fuzz/redaction-nightly.mjs), which sets
 *
 *   LUMEN_FUZZ_NIGHT   the seed, the UTC date as a number (default: today)
 *   LUMEN_FUZZ_N       cases in all, split across the generators (default 20,000)
 *   LUMEN_FUZZ_SAVE    the regression file to add minimised leaks to
 *   LUMEN_FUZZ_REPORT  where to write the night's JSON report
 *
 * A leak fails the run, and with LUMEN_FUZZ_SAVE its minimised note becomes a
 * case in tests/fuzz/redaction/regressions.json, which the main suite replays
 * (src/__tests__/redactionFuzzRegressions.test.ts) until it is fixed and after.
 */
import { describe, expect, it } from "vitest";
import { mergeRegressions, runCampaign, toRegression, type RegressionFile } from "./campaign";
import { seedForDate } from "./generators";
import { haveDom, leaksOf } from "./oracle";

const env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const night = Number(env.LUMEN_FUZZ_NIGHT ?? seedForDate(new Date()));
const n = Number(env.LUMEN_FUZZ_N ?? 20_000);

describe(`redaction fuzz, night ${night}`, () => {
  (haveDom ? it : it.skip)(`${n} cases across every generator: no token the preview shades survives the export`, async () => {
    const t0 = Date.now();
    const result = runCampaign({
      night,
      n,
      oracle: { check: (md) => { const l = leaksOf(md); return { leaked: [...l.full, ...l.blocks], shaded: l.shaded }; } },
    });
    const regressions = result.found.map((f) => toRegression(f, night));
    const fs = await import("node:fs").catch(() => null);
    let added = 0;
    if (fs && env.LUMEN_FUZZ_SAVE && regressions.length) {
      const file = JSON.parse(fs.readFileSync(env.LUMEN_FUZZ_SAVE, "utf8")) as RegressionFile;
      const merged = mergeRegressions(file, regressions);
      added = merged.added.length;
      fs.writeFileSync(env.LUMEN_FUZZ_SAVE, JSON.stringify(merged.file, null, 1) + "\n");
    }
    const report = { night, n, ms: Date.now() - t0, cases: result.cases, shaded: result.shaded, threw: result.threw, perGenerator: result.perGenerator, leaks: regressions, saved: added };
    if (fs && env.LUMEN_FUZZ_REPORT) fs.writeFileSync(env.LUMEN_FUZZ_REPORT, JSON.stringify(report, null, 1) + "\n");
    console.log(`FUZZ night ${night}: cases ${result.cases}, shaded ${result.shaded}, threw ${result.threw.length}, leaks ${regressions.length}, saved ${added}, ${Math.round(report.ms / 1000)} s ${JSON.stringify(result.perGenerator)}`);
    for (const r of regressions.slice(0, 5)) console.log("LEAK", JSON.stringify(r));
    // A night that shaded nothing proved nothing.
    expect(result.shaded).toBeGreaterThan(n / 4);
    expect(result.threw.slice(0, 3)).toEqual([]);
    expect(regressions.slice(0, 5)).toEqual([]);
  }, 6 * 60 * 60 * 1000);
});
