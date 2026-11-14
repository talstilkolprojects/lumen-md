#!/usr/bin/env node
/**
 * Plan 0.15 — mutation testing for the critical pure modules, without new
 * packages (Stryker is not in the lockfile). For each module in
 * targets.json: make small bugs (mutators.mjs), run the module's tests on
 * each, and count the mutants the tests catch.
 *
 *   node scripts/mutation/run.mjs                       # vitest, all modules
 *   node scripts/mutation/run.mjs --module keyring      # modules whose path contains "keyring"
 *   node scripts/mutation/run.mjs --max 80 --min 70     # sample size; fail under 70%
 *   node scripts/mutation/run.mjs --runner shim --shim <dir> --harness <file>
 *                                         # offline: a vitest shim, and a browser
 *                                         # harness for tests marked "runner": "harness"
 *
 * A mutant is killed when a test that passes on the real code fails, the
 * run crashes, or it times out (Stryker's convention: a hang is caught).
 * It survived when every test still passes. A mutant that does not parse
 * is left out. Score = killed / (killed + survived).
 *
 * The module file is mutated in place and always restored (also on Ctrl-C);
 * the run refuses to start while a target has uncommitted changes. Results:
 * reports/mutation/report.{json,md} with every survivor's line.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { apply, mutantsOf, parses, sample } from "./mutators.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const ts = createRequire(join(root, "package.json"))("typescript");
const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const runner = opt("runner", "vitest");
const shimDir = opt("shim", "");
// Offline only: a browser harness (`node <harness> <root> <test> [filter]`, printing
// "FAIL <name>" and "RESULT pass N fail M") for tests marked "runner": "harness".
const harness = opt("harness", "");
const max = Number(opt("max", "120"));
const min = Number(opt("min", "0"));
const only = opt("module", "");
const targets = JSON.parse(readFileSync(join(root, "scripts/mutation/targets.json"), "utf8")).modules;

function runTests(tests, timeoutMs) {
  const failed = new Set();
  let crashed = false;
  let timedOut = false;
  for (const t of tests) {
    let r;
    if (runner === "shim" && t.runner === "harness") {
      if (!harness) {
        crashed = true;
        continue;
      }
      r = spawnSync(process.execPath, [harness, root, t.file, ...(t.filter ? [t.filter] : [])], { cwd: root, encoding: "utf8", timeout: timeoutMs });
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      for (const m of out.matchAll(/^FAIL (.+?)\s*$/gm)) failed.add(`${t.file} :: ${m[1]}`);
      if (!/^RESULT pass \d+ fail \d+/m.test(out)) crashed = true;
    } else if (runner === "shim") {
      const dir = t.shim ?? shimDir;
      r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", "--import", join(dir, "register.mjs"), join(dir, "runner.mjs"), join(root, t.file), ...(t.filter ? [t.filter] : [])], { cwd: root, encoding: "utf8", timeout: timeoutMs });
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      for (const m of out.matchAll(/^FAIL (.+?)\s*$/gm)) failed.add(`${t.file} :: ${m[1]}`);
      if (!/^pass \d+ fail \d+/m.test(out)) crashed = true;
    } else {
      const outFile = join(root, "reports/mutation/.vitest.json");
      r = spawnSync("npx", ["vitest", "run", t.file, ...(t.filter ? ["-t", t.filter] : []), "--reporter=json", `--outputFile=${outFile}`], { cwd: root, encoding: "utf8", timeout: timeoutMs });
      try {
        const j = JSON.parse(readFileSync(outFile, "utf8"));
        for (const f of j.testResults ?? []) for (const a of f.assertionResults ?? []) if (a.status === "failed") failed.add(`${t.file} :: ${a.fullName}`);
        if (j.numFailedTestSuites > 0 && !failed.size) crashed = true;
      } catch {
        crashed = true;
      }
    }
    if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") timedOut = true;
  }
  return { failed, crashed, timedOut };
}

mkdirSync(join(root, "reports/mutation"), { recursive: true });
const report = [];
let restore = null;
const onSignal = () => {
  restore?.();
  process.exit(130);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

for (const [path, tests] of Object.entries(targets)) {
  if (only && !path.includes(only)) continue;
  const abs = join(root, path);
  const dirty = spawnSync("git", ["status", "--porcelain", "--", path], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (dirty) {
    console.error(`${path} has uncommitted changes; commit or stash them first.`);
    process.exit(2);
  }
  const original = readFileSync(abs, "utf8");
  restore = () => writeFileSync(abs, original);
  const t0 = Date.now();
  const base = runTests(tests, 600_000);
  const baseMs = Date.now() - t0;
  if (base.crashed || base.timedOut) {
    console.error(`${path}: the tests do not run on the real code; skipped.`);
    report.push({ module: path, error: "baseline did not run" });
    continue;
  }
  const all = mutantsOf(ts, original);
  const picked = sample(all, max);
  const row = { module: path, mutants: all.length, sampled: picked.length, killed: 0, survived: 0, timeout: 0, invalid: 0, score: 0, survivors: [] };
  const timeoutMs = Math.max(10_000, baseMs * 3);
  try {
    for (const m of picked) {
      const text = apply(original, m);
      if (!parses(ts, path, text)) {
        row.invalid++;
        continue;
      }
      writeFileSync(abs, text);
      const r = runTests(tests, timeoutMs);
      const newFail = [...r.failed].some((f) => !base.failed.has(f));
      if (r.timedOut) row.timeout++;
      else if (newFail || r.crashed) row.killed++;
      else {
        row.survived++;
        const line = original.slice(0, m.start).split("\n").length;
        row.survivors.push({ line, kind: m.kind, code: original.split("\n")[line - 1].trim().slice(0, 140) });
      }
    }
  } finally {
    restore();
    restore = null;
  }
  const caught = row.killed + row.timeout;
  row.score = caught + row.survived ? Math.round((caught / (caught + row.survived)) * 1000) / 10 : 0;
  report.push(row);
  console.log(`${path}: ${row.score}% (${caught} caught of ${caught + row.survived}; ${row.invalid} not parsing; ${row.mutants} mutants, ${row.sampled} run)`);
}

writeFileSync(join(root, "reports/mutation/report.json"), JSON.stringify(report, null, 2));
const md = ["# Mutation testing (plan 0.15)", "", "| Module | Score | Caught | Survived | Run / all |", "| --- | --- | --- | --- | --- |"];
for (const r of report) {
  if (r.error) md.push(`| ${r.module} | — | — | — | ${r.error} |`);
  else md.push(`| ${r.module} | ${r.score}% | ${r.killed + r.timeout} | ${r.survived} | ${r.sampled} / ${r.mutants} |`);
}
for (const r of report.filter((x) => x.survivors?.length)) {
  md.push("", `## ${r.module}: survivors`, "");
  for (const s of r.survivors) md.push(`- line ${s.line}, ${s.kind}: \`${s.code.replace(/`/g, "'")}\``);
}
writeFileSync(join(root, "reports/mutation/report.md"), md.join("\n") + "\n");
const low = report.filter((r) => !r.error && r.score < min);
if (min && low.length) {
  console.error(`below ${min}%: ${low.map((r) => r.module).join(", ")}`);
  process.exit(1);
}
