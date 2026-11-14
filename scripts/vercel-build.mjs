#!/usr/bin/env node
/**
 * The Vercel build, and the project's gates without GitHub Actions (W1.35).
 *
 * Vercel builds main and the verify/* integration trains (a PR branch is
 * verified through the train: scripts/vercel-ignore.sh) and reports the
 * result to GitHub as the "Vercel" commit status. A preview build therefore
 * runs the checks CI used to run, and any failing gate fails the build, so
 * a train with a failing test gets a red status. Production (main) builds as before:
 * the app and its bundle budget, nothing else.
 *
 *   VERCEL_ENV=preview      build, budget, vitest, e2e, i18n:check,
 *                           hygiene, docs:sync, the licence gate
 *   VERCEL_ENV=production   build, budget
 *   (not on Vercel)         the preview set, so `node scripts/vercel-build.mjs`
 *                           reproduces a preview build locally
 *
 * The gates run in that order; after the build, a failing gate no longer
 * stops the later ones, and the run exits at the end (exit code
 * 1), with one line per gate and its time. A preview that runs past
 * GATE_BUDGET_MIN (38) minutes fails too, so it never meets Vercel's
 * 45-minute stop (W6.8); every gate's time goes into a receipt,
 * reports/vercel-build.json, also served as /__build/receipt.json.
 *
 * Vitest runs with one worker per CPU the build may use (the cgroup quota,
 * not the host's core count) and without the suites that run only nightly
 * (scripts/test-tiers.mjs). LUMEN_VITEST_SHARD=i/n runs one shard (probes). The e2e gate
 * (scripts/e2e-gate.mjs) runs Playwright on chromium against `vite preview`
 * of this build: the specs that fit (the smoke spec today), time-boxed so
 * the build ends inside Vercel's 45 minutes.
 *
 * Usage: node scripts/vercel-build.mjs [--production | --preview | --e2e-only] [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { E2E_COLLAB_WS, GATE_BUDGET_MIN, VITEST_NIGHTLY_ONLY } from "./test-tiers.mjs";

/** Every gate: its name and the npm script that runs it. */
export const GATES = {
  build: ["run", "build"],
  budget: ["run", "budget"],
  vitest: ["run", "test"],
  e2e: ["run", "-s", "e2e:gate"],
  "i18n:check": ["run", "-s", "i18n:check"],
  hygiene: ["run", "-s", "hygiene"],
  "docs:sync": ["run", "-s", "docs:sync"],
  licenses: ["run", "-s", "licenses"],
  // W4.4: token shapes and VITE_* values not on the allowlist in dist/.
  secrets: ["run", "-s", "secrets:dist"],
};

/**
 * Arguments a gate's npm script gets on top. Vitest also writes its JSON
 * report, so a failed run ends with one short block naming every failing
 * file: the build log shows only its tail, and the failure dump of a big run
 * is thousands of lines (W1.1).
 */
export const VITEST_REPORT = "reports/vitest.json";
export const GATE_EXTRA = {
  vitest: ["--", "--reporter=default", "--reporter=json", `--outputFile.json=${VITEST_REPORT}`],
};

/**
 * CPUs from a cgroup v2 `cpu.max` ("<quota> <period>", or "max <period>"):
 * the quota rounded up, or null when there is none. A container reports the
 * host's cores to os.availableParallelism(), so a 2-CPU build box looked
 * like a big one and vitest started a fork per host core (W6.8: 1019 s, of
 * which 493 s was jsdom set-up).
 */
export function quotaFromCpuMax(text) {
  const [quota, period] = String(text ?? "").trim().split(/\s+/);
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return Math.max(1, Math.ceil(q / p));
}

/** CPUs this process may use: the cgroup quota when one is set, else the OS's count. */
export function usableCpus(read = (f) => readFileSync(f, "utf8"), osCount = availableParallelism()) {
  const tries = [
    () => quotaFromCpuMax(read("/sys/fs/cgroup/cpu.max")),
    () => quotaFromCpuMax(`${read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")} ${read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")}`),
  ];
  for (const t of tries) {
    try {
      const n = t();
      if (n) return { cpus: Math.min(n, osCount), os: osCount, quota: n };
    } catch {
      /* why: no such cgroup file on this system: try the next, then the OS's count */
    }
  }
  return { cpus: osCount, os: osCount, quota: null };
}

/** The vitest gate's arguments on top of GATE_EXTRA: workers, the nightly-only suites left out, a shard. */
export function vitestArgs(env = process.env, cpus = usableCpus().cpus) {
  const args = [`--maxWorkers=${Math.max(1, cpus)}`, ...VITEST_NIGHTLY_ONLY.map((f) => `--exclude=${f}`)];
  if (/^\d+\/\d+$/.test(env.LUMEN_VITEST_SHARD ?? "")) args.push(`--shard=${env.LUMEN_VITEST_SHARD}`);
  return args;
}

/** The `n` slowest files of a vitest JSON report: [{ file, seconds }], slowest first. */
export function slowestFiles(report, n = 25) {
  if (!report || !Array.isArray(report.testResults)) return [];
  const rel = (f) => String(f).replace(/^.*?(?=src\/|scripts\/|packages\/)/, "");
  return report.testResults
    .filter((f) => Number.isFinite(f.startTime) && Number.isFinite(f.endTime))
    .map((f) => ({ file: rel(f.name), seconds: Math.round((f.endTime - f.startTime) / 100) / 10 }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, n);
}

/** Minutes since the build started past the budget: a failure line, or null. */
export function budgetVerdict(startedMs, nowMs = Date.now(), budgetMin = GATE_BUDGET_MIN) {
  const min = (nowMs - startedMs) / 60_000;
  return min > budgetMin ? `the build took ${min.toFixed(1)} min, over the ${budgetMin}-minute budget (Vercel stops at 45)` : null;
}

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

export const PRODUCTION_GATES = ["build", "budget"];
export const PREVIEW_GATES = ["build", "budget", "secrets", "vitest", "e2e", "i18n:check", "hygiene", "docs:sync", "licenses"];
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
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const done = [];
  // After build, every gate runs even if an earlier one failed, so one
  // deployment reports every gate (the daily deployment quota is small).
  const failedGates = [];
  // The e2e gate sizes its time box from the build's start (scripts/e2e-gate.mjs).
  process.env.LUMEN_BUILD_STARTED ??= String(Date.now());
  // A build the e2e gate tests carries window.__lumenTest (src/testing/e2eHooks.ts),
  // through which specs reach the app's modules; production builds never do.
  if (gates.includes("e2e")) {
    process.env.VITE_E2E ??= "1";
    // e2e/collab-persist.spec.ts starts a collab server on loopback
    // (E2E_COLLAB_WS, scripts/test-tiers.mjs): this e2e build's page may reach
    // it; a production build never runs this branch.
    process.env.VITE_CSP_CONNECT_EXTRA = [process.env.VITE_CSP_CONNECT_EXTRA, E2E_COLLAB_WS].filter(Boolean).join(" ");
  }
  const cpu = usableCpus();
  console.log(`vercel-build: ${cpu.cpus} CPU(s) to use (os ${cpu.os}, cgroup quota ${cpu.quota ?? "none"})`);
  const receipt = { sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null, ref: process.env.VERCEL_GIT_COMMIT_REF ?? null, env: where, cpus: cpu, budgetMin: GATE_BUDGET_MIN, gates: [], slowestVitestFiles: [] };
  const buildStarted = Number(process.env.LUMEN_BUILD_STARTED);
  for (const gate of gates) {
    const started = Date.now();
    console.log(`\n▶ ${gate}`);
    const extra = gate === "vitest" ? [...GATE_EXTRA.vitest, ...vitestArgs(process.env, cpu.cpus)] : (GATE_EXTRA[gate] ?? []);
    const r = spawnSync(npm, [...GATES[gate], ...extra], { stdio: "inherit", env: process.env });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    receipt.gates.push({ gate, seconds: Number(secs), ok: r.status === 0 });
    if (gate === "vitest") {
      const slow = slowestFiles(readJson(VITEST_REPORT));
      receipt.slowestVitestFiles = slow;
      if (slow.length) console.log(`\nvitest: the slowest files (move one to VITEST_NIGHTLY_ONLY only if it is not a correctness test of the vault, sync or encryption):\n${slow.map((f) => `  ${String(f.seconds).padStart(6)} s  ${f.file}`).join("\n")}`);
    }
    if (r.status !== 0) {
      if (gate === "vitest") {
        const lines = vitestSummary(readJson(VITEST_REPORT));
        if (lines) console.error(`\n${lines.join("\n")}`);
      }
      console.error(`\n✗ vercel-build: the ${gate} gate failed (${secs} s, exit ${r.status ?? r.signal}).`);
      failedGates.push(`${gate} ${secs} s`);
      if (gate === "build") break; // nothing to check without a build
      continue;
    }
    done.push(`${gate} ${secs} s`);
  }
  const over = gates.length > 1 && Number.isFinite(buildStarted) ? budgetVerdict(buildStarted) : null;
  if (over) {
    console.error(`\n✗ vercel-build: ${over}.`);
    failedGates.push("time budget");
  }
  receipt.totalMinutes = Number.isFinite(buildStarted) ? Math.round((Date.now() - buildStarted) / 6000) / 10 : null;
  writeReceipt(receipt, where);
  if (failedGates.length) {
    console.error(`\n✗ vercel-build: failed: ${failedGates.join(" · ")}. Passed: ${done.join(" · ") || "none"}.`);
    process.exit(1);
  }
  console.log(`\n✓ vercel-build: ${done.join(" · ")}`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; /* why: no report: the step did not get that far */
  }
}

/** reports/vercel-build.json, and on a preview dist/__build/receipt.json too (read back from the deployment). */
function writeReceipt(receipt, where) {
  const files = ["reports/vercel-build.json", ...(where === "VERCEL_ENV=production" ? [] : ["dist/__build/receipt.json"])];
  for (const f of files) {
    try {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(receipt, null, 2) + "\n");
    } catch (e) {
      console.error(`vercel-build: could not write ${f}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
