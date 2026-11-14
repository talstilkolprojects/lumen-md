#!/usr/bin/env node
/**
 * Nightly flake report (plan 0.11): merges the per-browser summaries that
 * `npm run e2e:flake` writes (flake-results/summary.json, one artifact per
 * browser) into reports/flake-report.{json,md} and the job summary.
 *
 *   node scripts/nightly/flake-report.mjs <dir with flake-results-*>/
 *
 * Exit 0 always: the browser jobs already fail on a flake; this one reports.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { summary, table, writeReport } from "./lib.mjs";

const dir = process.argv[2] ?? "artifacts";
const browsers = [];
for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
  const f = join(dir, name, "summary.json");
  if (!name.startsWith("flake-results-")) continue;
  const browser = name.slice("flake-results-".length);
  if (!existsSync(f)) {
    browsers.push({ browser, missing: true });
    continue;
  }
  const s = JSON.parse(readFileSync(f, "utf8"));
  browsers.push({
    browser,
    times: s.times,
    tests: Object.keys(s.tests).length,
    flaky: s.flaky,
    broken: s.broken,
    failures: Object.entries(s.tests)
      .filter(([, t]) => t.fail > 0)
      .map(([test, t]) => ({ test, failed: t.fail, of: t.pass + t.fail, runs: t.runs })),
  });
}

const report = { date: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ?? null, browsers };
writeReport("flake-report.json", report);

const flakyTotal = browsers.reduce((n, b) => n + (b.flaky?.length ?? 0), 0);
const brokenTotal = browsers.reduce((n, b) => n + (b.broken?.length ?? 0), 0);
const missing = browsers.filter((b) => b.missing).map((b) => b.browser);
const lines = [
  `## e2e flake report: ${flakyTotal} flaky, ${brokenTotal} always failing${missing.length ? `, no summary from ${missing.join(", ")}` : ""}`,
  "",
  table(
    ["browser", "tests", "runs", "flaky", "always failing"],
    browsers.map((b) => (b.missing ? [b.browser, "–", "–", "did not finish", "–"] : [b.browser, b.tests, b.times, b.flaky.length, b.broken.length])),
  ),
];
const failures = browsers.flatMap((b) => (b.failures ?? []).map((f) => [b.browser, f.test, `${f.failed}/${f.of}`, f.runs.join(", ")]));
if (failures.length) lines.push("", table(["browser", "test", "failed", "runs"], failures));
if (!browsers.length) lines.push("", "No flake-results artifacts were found.");
const md = lines.join("\n") + "\n";
writeReport("flake-report.md", md);
summary(md);
