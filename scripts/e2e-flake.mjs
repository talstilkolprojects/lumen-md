#!/usr/bin/env node
/**
 * Flake hunter (MASTER_PLAN v3, T23): run one spec (or the whole suite)
 * N times with retries off and a trace on every run, then say exactly
 * which tests failed how often. A test that passes 10/10 earns the
 * right to run without retries; one that fails 1/10 is a bug to fix,
 * not a retry to add.
 *
 *   npm run e2e:flake -- e2e/rtl.spec.ts --times 10
 *   npm run e2e:flake -- --times 5 --project firefox
 *   npm run e2e:flake -- --all --times 5          # every browser project
 *   npm run e2e:flake -- e2e/smoke.spec.ts -g "locale" --times 20
 *
 * Any other argument is passed through to `playwright test`.
 * Exit code 1 when any run failed. Reports land in flake-results/
 * (flake-results/<project>/ with --all); a failed test's trace, screenshot
 * and video are kept in run-<n>-failures/ next to that run's report.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The browser projects in playwright.config.ts, for --all. */
const ALL_PROJECTS = ["chromium", "firefox", "webkit"];

const argv = process.argv.slice(2);
let times = 10;
let project = "chromium";
let all = false;
const passthrough = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--times") times = Number(argv[++i]) || times;
  else if (a.startsWith("--times=")) times = Number(a.slice(8)) || times;
  else if (a === "--project") project = argv[++i] ?? project;
  else if (a.startsWith("--project=")) project = a.slice(10);
  else if (a === "--all") all = true;
  else passthrough.push(a);
}

const root = join(process.cwd(), "flake-results");
let anyFail = false;
for (const p of all ? ALL_PROJECTS : [project]) {
  if (hunt(p, all ? join(root, p) : root)) anyFail = true;
}
process.exit(anyFail ? 1 : 0);

/**
 * Copy a failed spec's trace, screenshot and video out of test-results/:
 * the next run replaces that folder, and the nightly uploads flake-results/.
 */
function keepAttachments(spec, dest) {
  for (const test of spec.tests ?? []) {
    for (const result of test.results ?? []) {
      if (result.status === "passed" || result.status === "skipped") continue;
      for (const a of result.attachments ?? []) {
        if (!a.path || !existsSync(a.path)) continue;
        // test-results/<test dir>/<file>: keep the test dir so files stay apart.
        const target = join(dest, basename(dirname(a.path)), basename(a.path));
        try {
          mkdirSync(dirname(target), { recursive: true });
          cpSync(a.path, target);
        } catch (e) {
          console.error(`could not keep ${a.path}: ${e.message}`);
        }
      }
    }
  }
}

/** Runs the suite `times` times on one project; true when any run failed. */
function hunt(project, outDir) {
  mkdirSync(outDir, { recursive: true });

  /** @type {Map<string, { pass: number; fail: number; runs: number[] }>} */
  const tally = new Map();
  let anyFail = false;

  for (let run = 1; run <= times; run++) {
    const report = join(outDir, `run-${run}.json`);
    const args = ["playwright", "test", `--project=${project}`, "--retries=0", "--trace=on", "--reporter=json", ...passthrough];
    const started = Date.now();
    const res = spawnSync("npx", args, {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report, CI: process.env.CI ?? "" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!existsSync(report) && res.stdout) writeFileSync(report, res.stdout);
    let json;
    try {
      json = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      console.error(`run ${run}: no JSON report (playwright exited ${res.status})`);
      anyFail = true;
      continue;
    }
    let failedThisRun = 0;
    const walk = (suite, prefix) => {
      for (const spec of suite.specs ?? []) {
        const title = `${prefix}${spec.title}`;
        const ok = spec.ok;
        const t = tally.get(title) ?? { pass: 0, fail: 0, runs: [] };
        if (ok) t.pass++;
        else {
          t.fail++;
          t.runs.push(run);
          failedThisRun++;
          keepAttachments(spec, join(outDir, `run-${run}-failures`));
        }
        tally.set(title, t);
      }
      for (const s of suite.suites ?? []) walk(s, `${prefix}${s.title} › `);
    };
    for (const s of json.suites ?? []) walk(s, `${s.title} › `);
    if (failedThisRun) anyFail = true;
    console.log(`run ${run}/${times}: ${failedThisRun ? `${failedThisRun} failed` : "green"} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }

  const rows = [...tally.entries()].sort((a, b) => b[1].fail - a[1].fail || a[0].localeCompare(b[0]));
  const flaky = rows.filter(([, t]) => t.fail > 0 && t.pass > 0);
  const broken = rows.filter(([, t]) => t.fail > 0 && t.pass === 0);
  console.log("");
  console.log(`${rows.length} tests × ${times} runs on ${project}: ${flaky.length} flaky, ${broken.length} always failing`);
  for (const [title, t] of rows) {
    if (t.fail === 0) continue;
    console.log(`  ${t.pass === 0 ? "✗" : "~"} ${title} — failed ${t.fail}/${t.pass + t.fail} (runs ${t.runs.join(", ")})`);
  }
  const summary = { project, times, args: passthrough, tests: Object.fromEntries(rows), flaky: flaky.map(([k]) => k), broken: broken.map(([k]) => k) };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`traces: test-results/ · summary: ${join(outDir, "summary.json")}`);
  return anyFail;
}
