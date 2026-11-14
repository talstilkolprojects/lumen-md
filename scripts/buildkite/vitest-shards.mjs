#!/usr/bin/env node
/**
 * Vitest in N shards balanced by time (plan W7.21). `vitest --shard` splits
 * by file count, so one shard can get the slow files; here the files are
 * packed by their last measured time instead (lib.mjs planShards).
 *
 *   node scripts/buildkite/vitest-shards.mjs plan --shards 4 [--timings f.json] --out ci-out/vitest-shards.json
 *   node scripts/buildkite/vitest-shards.mjs run --plan ci-out/vitest-shards.json [--index i]
 *       one shard (i: BUILDKITE_PARALLEL_JOB, 0-based): vitest run --coverage with a blob report
 *   node scripts/buildkite/vitest-shards.mjs merge --plan ci-out/vitest-shards.json
 *       vitest --merge-reports of .vitest/blob (with coverage), then the checks: every
 *       planned file ran, nothing ran unplanned, the must-run suites passed (E65).
 *       Writes ci-out/vitest-summary.json and ci-out/vitest-timings.json (the next plan's input).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUST_RUN_VITEST } from "../factory/lib.mjs";
import { VITEST_INCLUDE, globRegExp, mergeCheck, planShards } from "./lib.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null; // why: a first run has no timings, a failed shard no report
  }
};
const write = (f, v) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
};

/** Every test file VITEST_INCLUDE matches (node_modules and dot-directories left out). */
function testFiles() {
  const res = VITEST_INCLUDE.map(globRegExp);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${name}` : name;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) walk(rel);
      else if (res.some((re) => re.test(rel))) out.push(rel);
    }
  };
  for (const top of ["src", "packages"]) if (existsSync(join(root, top))) walk(top);
  return out.sort();
}

if (cmd === "plan") {
  const n = Number(opt("shards", "4"));
  if (!Number.isInteger(n) || n < 1) throw new Error("--shards must be a positive integer");
  const files = testFiles();
  if (!files.length) throw new Error(`no test files match ${VITEST_INCLUDE.join(", ")}`);
  const timings = readJson(opt("timings", "")) ?? {};
  const sizes = Object.fromEntries(files.map((f) => [f, statSync(join(root, f)).size]));
  const plan = planShards(files, n, { timings, sizes });
  write(opt("out", "ci-out/vitest-shards.json"), { version: 1, include: VITEST_INCLUDE, files: files.length, ...plan });
  console.log(`${files.length} files in ${n} shards by ${plan.basis} (${plan.measured} measured); predicted spread ${Math.round(plan.spread * 100)}%`);
  for (const s of plan.shards) console.log(`  shard ${s.index + 1}: ${s.files.length} files, ~${Math.round(s.ms / 1000)} ${plan.basis === "timings" ? "s" : "k-bytes"}`);
} else if (cmd === "run") {
  const plan = readJson(opt("plan", "ci-out/vitest-shards.json"));
  if (!plan) throw new Error("no shard plan: the vitest-plan step's artifact is missing");
  const i = Number(opt("index", process.env.BUILDKITE_PARALLEL_JOB ?? "0"));
  const count = Number(process.env.BUILDKITE_PARALLEL_JOB_COUNT ?? plan.shards.length);
  if (count !== plan.shards.length) throw new Error(`the step runs ${count} jobs but the plan has ${plan.shards.length} shards`);
  const shard = plan.shards[i];
  if (!shard) throw new Error(`no shard ${i}`);
  console.log(`shard ${i + 1}/${plan.shards.length}: ${shard.files.length} files`);
  const r = spawnSync("npx", ["vitest", "run", "--coverage", "--reporter=default", "--reporter=blob", `--outputFile.blob=.vitest/blob/shard-${i + 1}.json`, ...shard.files], { cwd: root, stdio: "inherit", env: { ...process.env, VITEST_BLOB_LABEL: process.env.VITEST_BLOB_LABEL ?? "" } });
  process.exit(r.status ?? 1);
} else if (cmd === "merge") {
  const plan = readJson(opt("plan", "ci-out/vitest-shards.json"));
  if (!plan) throw new Error("no shard plan");
  const blobs = existsSync(join(root, ".vitest/blob")) ? readdirSync(join(root, ".vitest/blob")).filter((f) => f.endsWith(".json")) : [];
  console.log(`${blobs.length} of ${plan.shards.length} shard reports`);
  const r = spawnSync("npx", ["vitest", "run", "--merge-reports=.vitest/blob", "--coverage", "--reporter=default", "--reporter=json", "--outputFile.json=ci-out/vitest.json"], { cwd: root, stdio: "inherit" });
  const report = readJson(join(root, "ci-out/vitest.json"));
  const res = mergeCheck(plan, report, `${root}/`, MUST_RUN_VITEST);
  if (blobs.length !== plan.shards.length) res.problems.unshift(`${plan.shards.length - blobs.length} shard report(s) missing`);
  const ok = r.status === 0 && res.ok && blobs.length === plan.shards.length;
  const { timings, ...summary } = res;
  write(join(root, "ci-out/vitest-summary.json"), { ...summary, ok, problems: res.problems, predictedSpread: plan.spread });
  if (Object.keys(timings).length) write(join(root, "ci-out/vitest-timings.json"), timings);
  console.log(`${res.tests - res.failed}/${res.tests} tests in ${res.files} files; actual shard spread ${Math.round(res.spread * 100)}% (predicted ${Math.round(plan.spread * 100)}%)`);
  for (const p of res.problems) console.error(`✗ ${p}`);
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: vitest-shards.mjs plan|run|merge (see the header)");
  process.exit(2);
}
