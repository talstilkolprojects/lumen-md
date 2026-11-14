#!/usr/bin/env node
/**
 * The local responsiveness gate (plan W1.22).
 *
 *   npm run perf:inp                 # measure (Playwright "inp" project) and gate
 *   node scripts/perf/inp-gate.mjs   # gate reports/perf/inp-latest.json against the baseline
 *     --record    also append the run to reports/perf/inp-trend.jsonl (one line per merge)
 *     --update    make the latest run the new baseline (reports/perf/inp-baseline.json)
 *
 * Fails (exit 1) when a metric is 10 % or more slower than the baseline:
 * INP p75 over the 20 interactions, and keypress → paint p95 in the 50 KB
 * and the 2 MB note. Lower is better for all three. The absolute budgets
 * (p75 < 100 ms, p95 < 16 / 33 ms) are asserted by e2e/inp-budget.spec.ts
 * itself.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REGRESSION = 0.1;

/** The gated numbers of a run, by name. */
export function gatedMetrics(run) {
  return {
    "INP p75": run?.inpP75,
    "keypress→paint p95 (50KB)": run?.keyToPaintP95?.["50KB"],
    "keypress→paint p95 (2MB)": run?.keyToPaintP95?.["2MB"],
  };
}

/**
 * Compare `latest` with `baseline`: one row per metric present in both,
 * `regressed` when latest ≥ baseline × (1 + REGRESSION). A baseline under
 * 1 ms is compared against 1 ms, so noise at the floor never fails.
 */
export function compare(baseline, latest, threshold = REGRESSION) {
  const b = gatedMetrics(baseline);
  const l = gatedMetrics(latest);
  return Object.keys(b)
    .filter((k) => typeof b[k] === "number" && typeof l[k] === "number")
    .map((k) => {
      const base = Math.max(b[k], 1);
      const change = (l[k] - base) / base;
      return { metric: k, baseline: b[k], latest: l[k], change, regressed: change >= threshold };
    });
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dir = join(root, "reports", "perf");
  const latestPath = join(dir, "inp-latest.json");
  const basePath = join(dir, "inp-baseline.json");
  const args = process.argv.slice(2);
  if (!existsSync(latestPath)) {
    console.error("inp-gate: no reports/perf/inp-latest.json — run `npm run perf:inp` first");
    process.exit(2);
  }
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  if (args.includes("--record")) appendFileSync(join(dir, "inp-trend.jsonl"), JSON.stringify(latest) + "\n");
  if (args.includes("--update") || !existsSync(basePath)) {
    const first = !existsSync(basePath);
    writeFileSync(basePath, JSON.stringify(latest, null, 2) + "\n");
    console.log(first ? "inp-gate: no baseline yet — this run is now reports/perf/inp-baseline.json; commit it" : "inp-gate: reports/perf/inp-baseline.json updated");
    return;
  }
  const rows = compare(JSON.parse(readFileSync(basePath, "utf8")), latest);
  for (const r of rows) {
    const pct = `${r.change >= 0 ? "+" : ""}${(r.change * 100).toFixed(1)} %`;
    console.log(`${r.regressed ? "✗" : "✓"} ${r.metric.padEnd(28)} ${r.baseline.toFixed(1).padStart(7)} → ${r.latest.toFixed(1).padStart(7)} ms  ${pct}`);
  }
  const bad = rows.filter((r) => r.regressed);
  if (bad.length) {
    console.error(`inp-gate: ${bad.length} metric(s) ${REGRESSION * 100} % or more slower than the baseline`);
    process.exit(1);
  }
  console.log("inp-gate: no regression");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
