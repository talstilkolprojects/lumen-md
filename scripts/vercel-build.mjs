#!/usr/bin/env node
/**
 * The Vercel build, and the project's gates without GitHub Actions (W1.35).
 *
 * Vercel builds main and the verify/* integration trains (a PR branch is
 * verified through the train: scripts/vercel-ignore.sh) and reports the
 * result to GitHub as the "Vercel" commit status. A preview build therefore
 * runs the checks CI used to run, and any failing gate fails the build, so
 * a train with a failing test gets a red status. Production (main) builds as before:
 * the app, its bundle budget and its build manifest (W7.23), nothing else.
 *
 *   VERCEL_ENV=preview      lockfile, build, budget, secrets, manifest,
 *                           vitest, e2e, i18n:check,
 *                           hygiene, docs:sync, docs:complete (with the
 *                           strict Hebrew parity), the licence gate, the mutation floor
 *   VERCEL_ENV=production   build, budget, manifest (after the scans: its
 *                           hashes are not secrets, but they look like them)
 *   (not on Vercel)         the preview set, so `node scripts/vercel-build.mjs`
 *                           reproduces a preview build locally
 *
 * The gates run in that order; after the build, a failing gate no longer
 * stops the later ones, and the run exits at the end (exit code
 * 1), with one line per gate and its time. The e2e gate
 * (scripts/e2e-gate.mjs) runs Playwright on chromium against `vite preview`
 * of this build: the specs that fit (the smoke spec today), time-boxed so
 * the build ends inside Vercel's 45 minutes.
 *
 * Usage: node scripts/vercel-build.mjs [--production | --preview | --e2e-only] [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Every gate: its name and the npm script that runs it. */
export const GATES = {
  // W8.9: what the gates test is what package-lock.json names (scripts/lockfile-drift.mjs).
  lockfile: ["run", "-s", "lockfile:drift"],
  build: ["run", "build"],
  // W7.23: the manifest of this dist, which the second infrastructure's build is compared with.
  manifest: ["run", "-s", "build:manifest"],
  budget: ["run", "budget"],
  vitest: ["run", "test"],
  e2e: ["run", "-s", "e2e:gate"],
  "i18n:check": ["run", "-s", "i18n:check"],
  hygiene: ["run", "-s", "hygiene"],
  "docs:sync": ["run", "-s", "docs:sync"],
  // W6.28: every page in English and Hebrew, and each Hebrew page with its English page's sections (docs-parity --strict).
  "docs:complete": ["run", "-s", "docs:complete"],
  licenses: ["run", "-s", "licenses"],
  // W4.4: token shapes and VITE_* values not on the allowlist in dist/.
  secrets: ["run", "-s", "secrets:dist"],
  // The committed mutation scores of the critical modules, against their current source (W4.17).
  mutation: ["run", "-s", "mutation:check"],
};

/**
 * Arguments a gate's npm script gets on top. The budget gate writes its
 * sizes (and prints them as one `bundle-sizes:` line in the log). Vitest also writes its JSON
 * report, so a failed run ends with one short block naming every failing
 * file: the build log shows only its tail, and the failure dump of a big run
 * is thousands of lines (W1.1).
 */
export const VITEST_REPORT = "reports/vitest.json";
/** The budget gate's receipt (plan W6.26): what `npm run budget:ratchet -- --sizes` lowers the budgets to after a train. */
export const SIZES_REPORT = "reports/bundle-sizes.json";
export const GATE_EXTRA = {
  vitest: ["--", "--reporter=default", "--reporter=json", `--outputFile.json=${VITEST_REPORT}`],
  budget: ["--", "--json", SIZES_REPORT],
};

/**
 * The end-of-log summary of a vitest JSON report (its jest-style shape):
 * the counts, then each failing file with up to three failing tests and the
 * first line of the first error. Lines, or null when there is no report.
 */
export function vitestSummary(report, { maxFiles = 80 } = {}) {
  if (!report || !Array.isArray(report.testResults)) return null;
  const firstLine = (m) => String(m ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const cut = (t, n = 220) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const rel = (f) => String(f).replace(/^.*?(?=src\/|scripts\/|e2e\/)/, "");
  const failed = report.testResults.filter((f) => f.status === "failed");
  const out = [
    `✗ vitest summary: files ${report.numFailedTestSuites ?? failed.length} failed / ${report.numTotalTestSuites ?? report.testResults.length}; tests ${report.numFailedTests ?? 0} failed, ${report.numPassedTests ?? 0} passed / ${report.numTotalTests ?? 0}`,
  ];
  for (const f of failed.slice(0, maxFiles)) {
    const tests = (f.assertionResults ?? []).filter((a) => a.status === "failed");
    out.push(`  ${rel(f.name)}: ${tests.length ? `${tests.length} failed` : "the file failed to run"}`);
    if (!tests.length && f.message) out.push(`      ${cut(firstLine(f.message))}`);
    for (const a of tests.slice(0, 3)) out.push(`    × ${cut(a.fullName ?? a.title ?? "?", 160)}`, `      ${cut(firstLine(a.failureMessages?.[0]))}`);
    if (tests.length > 3) out.push(`    … ${tests.length - 3} more`);
  }
  if (failed.length > maxFiles) out.push(`  … ${failed.length - maxFiles} more files`);
  return out;
}

export const PRODUCTION_GATES = ["build", "budget", "manifest"];
export const PREVIEW_GATES = ["lockfile", "build", "budget", "secrets", "manifest", "vitest", "e2e", "i18n:check", "hygiene", "docs:sync", "docs:complete", "licenses", "mutation"];
/**
 * `--e2e-only`: build and the e2e gate, nothing else. For a probe branch
 * that runs Playwright specs (LUMEN_E2E_SPECS, a longer LUMEN_E2E_MINUTES)
 * without the 13 minutes of vitest; never a branch's real gate.
 */
export const E2E_ONLY_GATES = ["build", "e2e"];

/** Which gates a build runs: production only for VERCEL_ENV=production (or --production). */
export function gatesFor(env = process.env, argv = []) {
  if (argv.includes("--e2e-only")) return E2E_ONLY_GATES;
  if (argv.includes("--production")) return PRODUCTION_GATES;
  if (argv.includes("--preview")) return PREVIEW_GATES;
  return env.VERCEL_ENV === "production" ? PRODUCTION_GATES : PREVIEW_GATES;
}

function main() {
  const argv = process.argv.slice(2);
  const gates = gatesFor(process.env, argv);
  const where = process.env.VERCEL_ENV ? `VERCEL_ENV=${process.env.VERCEL_ENV}` : "local";
  console.log(`vercel-build (${where}): ${gates.join(" → ")}`);
  if (argv.includes("--dry-run")) return;
  // Plan W6.9: no build that takes payments on a plan without commercial use (deploy/hosting.json).
  const hosting = spawnSync(process.execPath, ["scripts/hosting-gate.mjs"], { stdio: "inherit", env: process.env });
  if (hosting.status !== 0) {
    console.error("\n✗ vercel-build: the hosting gate failed (docs self-hosting/cut-over).");
    process.exit(1);
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const done = [];
  // After build, every gate runs even if an earlier one failed, so one
  // deployment reports every gate (the daily deployment quota is small).
  const failedGates = [];
  // The e2e gate sizes its time box from the build's start (scripts/e2e-gate.mjs).
  process.env.LUMEN_BUILD_STARTED ??= String(Date.now());
  // A build the e2e gate tests carries window.__lumenTest (src/testing/e2eHooks.ts),
  // through which specs reach the app's modules; production builds never do.
  if (gates.includes("e2e")) process.env.VITE_E2E ??= "1";
  for (const gate of gates) {
    const started = Date.now();
    console.log(`\n▶ ${gate}`);
    const r = spawnSync(npm, [...GATES[gate], ...(GATE_EXTRA[gate] ?? [])], { stdio: "inherit", env: process.env });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (r.status !== 0) {
      if (gate === "vitest") {
        let report = null;
        try {
          report = JSON.parse(readFileSync(VITEST_REPORT, "utf8"));
        } catch {
          /* no report: vitest did not get that far */
        }
        const lines = vitestSummary(report);
        if (lines) console.error(`\n${lines.join("\n")}`);
      }
      console.error(`\n✗ vercel-build: the ${gate} gate failed (${secs} s, exit ${r.status ?? r.signal}).`);
      failedGates.push(`${gate} ${secs} s`);
      if (gate === "build") break; // nothing to check without a build
      continue;
    }
    done.push(`${gate} ${secs} s`);
  }
  if (failedGates.length) {
    console.error(`\n✗ vercel-build: failed: ${failedGates.join(" · ")}. Passed: ${done.join(" · ") || "none"}.`);
    process.exit(1);
  }
  console.log(`\n✓ vercel-build: ${done.join(" · ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
