#!/usr/bin/env node
/**
 * Percy snapshots of the 30 screens (plan W7.25), from W7.21's pipeline, not
 * from GitHub Actions:
 *
 *   PERCY_TOKEN=… node scripts/visual/percy-run.mjs [--canary]
 *
 * Runs `percy exec` (the CLI pinned below, fetched by npx: no new dependency
 * in the lockfile) around the Playwright Percy suite. --canary runs the 2px
 * RTL self-test as its own build (LUMEN_PERCY_CANARY=1, branch
 * percy-canary/<date>), which must show changes in every browser and is
 * never approved.
 */
import { spawnSync } from "node:child_process";

export const PERCY_CLI = "@percy/cli@1.31.4";

export function percyCommand(argv = process.argv.slice(2), env = process.env, now = new Date()) {
  if (!env.PERCY_TOKEN) throw new Error("PERCY_TOKEN is not set (it lives in the agent's secret store)");
  const canary = argv.includes("--canary");
  const extra = canary ? { LUMEN_PERCY_CANARY: "1", PERCY_BRANCH: `percy-canary/${now.toISOString().slice(0, 10)}` } : {};
  return { cmd: "npx", args: ["-y", PERCY_CLI, "exec", "--", "npx", "playwright", "test", "-c", "playwright.percy.config.ts"], env: { ...env, ...extra } };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const c = percyCommand();
  const r = spawnSync(c.cmd, c.args, { stdio: "inherit", env: c.env });
  process.exit(r.status ?? 1);
}
