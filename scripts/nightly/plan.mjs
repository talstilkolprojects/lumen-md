#!/usr/bin/env node
/**
 * The nightly full run (plan W6.8, W6.5, W6.10): what the Vercel gate leaves
 * out, on the second host (Docker `ci:local`, #484, or the owner's machine,
 * W4.36), every night:
 *
 *   build       the production build with VITE_E2E=1 and the collab origin
 *   vitest      the WHOLE suite (VITEST_NIGHTLY_ONLY included), in VITEST_SHARDS shards
 *   e2e         every spec on chromium, firefox and webkit, E2E_SHARDS shards each,
 *               against that build (scripts/nightly/e2e-shard.mjs)
 *   perf        the @nightly perf project (timing budgets, e2e/perf-vault.spec.ts)
 *   vercel      the project's Ignored Build Step is our skip script (W6.10)
 *
 * The steps have the shape scripts/nightly/run.mjs (#455) runs: { id, cmd,
 * timeoutMin, env? }, plus `parallel`: steps of one group may run side by
 * side. Until #455 is on the train, this file runs them itself:
 *
 *   node scripts/nightly/plan.mjs              print the plan
 *   node scripts/nightly/plan.mjs --run [--jobs N] [--only vitest,e2e]
 *
 * With --run it writes reports/nightly/full-<date>.json (one line per step:
 * id, status, minutes) and exits 1 when any step failed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_BROWSERS, E2E_COLLAB_WS, E2E_SHARDS, VITEST_SHARDS } from "../test-tiers.mjs";

export const GROUPS = ["build", "vitest", "e2e", "perf", "vercel"];

/** Every step of the full nightly run, in order. */
export function fullSteps({ vitestShards = VITEST_SHARDS, e2eShards = E2E_SHARDS, browsers = E2E_BROWSERS } = {}) {
  const steps = [
    { id: "build", group: "build", cmd: ["npm", "run", "build"], env: { VITE_E2E: "1", VITE_CSP_CONNECT_EXTRA: E2E_COLLAB_WS }, timeoutMin: 20 },
  ];
  for (let i = 1; i <= vitestShards; i++)
    steps.push({
      id: `vitest-${i}of${vitestShards}`,
      group: "vitest",
      parallel: true,
      // No --exclude: the nightly run is the whole suite, the gate's nightly-only files included.
      cmd: ["npx", "vitest", "run", `--shard=${i}/${vitestShards}`, "--reporter=default", "--reporter=json", `--outputFile.json=reports/nightly/vitest-${i}of${vitestShards}.json`],
      timeoutMin: 45,
    });
  for (const browser of browsers)
    for (let i = 1; i <= e2eShards; i++)
      steps.push({ id: `e2e-${browser}-${i}of${e2eShards}`, group: "e2e", parallel: true, cmd: ["node", "scripts/nightly/e2e-shard.mjs", browser, `${i}/${e2eShards}`], timeoutMin: 40 });
  steps.push({ id: "perf-e2e", group: "perf", cmd: ["node", "scripts/nightly/e2e-shard.mjs", "perf", "1/1"], timeoutMin: 30 });
  steps.push({ id: "vercel-ignore-step", group: "vercel", cmd: ["node", "scripts/check-vercel-ignore.mjs"], timeoutMin: 2 });
  return steps;
}

function runOne(step) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(step.cmd[0], step.cmd.slice(1), { stdio: "inherit", env: { ...process.env, ...(step.env ?? {}) } });
    const timer = setTimeout(() => child.kill("SIGTERM"), step.timeoutMin * 60_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const status = code === 0 ? "ok" : code === 2 && step.id === "vercel-ignore-step" ? "unknown" : signal ? `killed ${signal}` : `exit ${code}`;
      done({ id: step.id, status, minutes: Math.round((Date.now() - t0) / 6000) / 10 });
    });
  });
}

/** Run the plan group by group; a group's parallel steps `jobs` at a time. */
export async function runPlan(steps, { jobs = 1, run = runOne } = {}) {
  const results = [];
  for (const group of GROUPS) {
    const queue = steps.filter((s) => s.group === group);
    const width = queue.every((s) => s.parallel) ? Math.max(1, jobs) : 1;
    const active = new Set();
    for (const step of queue) {
      const p = run(step).then((r) => {
        results.push(r);
        active.delete(p);
      });
      active.add(p);
      if (active.size >= width) await Promise.race(active);
    }
    await Promise.all(active);
  }
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = opt("only")?.split(",");
  const steps = fullSteps().filter((s) => !only || only.includes(s.group));
  if (!argv.includes("--run")) {
    for (const s of steps) console.log(`${s.group.padEnd(7)} ${s.parallel ? "∥" : " "} ${s.id.padEnd(22)} ${s.cmd.join(" ")}`);
    return;
  }
  const jobs = Number(opt("jobs") ?? Math.max(1, Math.floor(availableParallelism() / 2)));
  const results = await runPlan(steps, { jobs });
  mkdirSync("reports/nightly", { recursive: true });
  const file = `reports/nightly/full-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(file, JSON.stringify({ jobs, results }, null, 2) + "\n");
  const bad = results.filter((r) => r.status !== "ok");
  console.log(`\nnightly full: ${results.length - bad.length}/${results.length} ok → ${file}${bad.length ? `\n  not ok: ${bad.map((r) => `${r.id} (${r.status})`).join(", ")}` : ""}`);
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
