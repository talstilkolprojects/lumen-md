#!/usr/bin/env node
/**
 * One shard of the nightly full e2e run (plan W6.8, W6.5): every spec of one
 * Playwright project, `--shard=i/n`, against the production build (dist/,
 * served by `vite preview` on its own port), so shards can run side by side
 * on the nightly host. Writes reports/nightly/e2e-<project>-<i>of<n>.json.
 *
 *   node scripts/nightly/e2e-shard.mjs <project> <i>/<n> [--workers N]
 *
 * The build must be made with VITE_E2E=1 and the collab origin in the CSP
 * (the plan's "build" step does both: scripts/nightly/plan.mjs). Exit code:
 * Playwright's.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** "2/4" → { index: 2, total: 4 }, or null when it is not a valid shard. */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text ?? ""));
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  return index >= 1 && index <= total ? { index, total } : null;
}

/** A free-enough port per shard: preview ports 4300 + 10·project + shard, so parallel shards never collide. */
export function shardPort(project, index, projects = ["chromium", "firefox", "webkit", "perf"]) {
  const p = Math.max(0, projects.indexOf(project));
  return 4300 + p * 10 + index;
}

export function reportFile(project, shard) {
  return `reports/nightly/e2e-${project}-${shard.index}of${shard.total}.json`;
}

async function main() {
  const [project, shardText, ...rest] = process.argv.slice(2);
  const shard = parseShard(shardText);
  if (!project || !shard) {
    console.error("usage: node scripts/nightly/e2e-shard.mjs <project> <i>/<n> [--workers N]");
    process.exit(2);
  }
  const wi = rest.indexOf("--workers");
  const workers = wi >= 0 ? rest[wi + 1] : "1";
  if (!existsSync("dist/index.html")) {
    console.error("[e2e-shard] no dist/: run the plan's build step first");
    process.exit(1);
  }
  const port = shardPort(project, shard.index);
  const base = `http://127.0.0.1:${port}`;
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const preview = spawn(npx, ["vite", "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "ignore", "inherit"] });
  const deadline = Date.now() + 60_000;
  while (!(await fetch(`${base}/`).then((r) => r.ok, () => false))) {
    if (Date.now() > deadline) {
      preview.kill();
      console.error(`[e2e-shard] vite preview did not answer on ${port} within 60 s`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  mkdirSync("reports/nightly", { recursive: true });
  const out = reportFile(project, shard);
  const r = spawnSync(npx, ["playwright", "test", `--project=${project}`, `--shard=${shard.index}/${shard.total}`, `--workers=${workers}`, "--reporter=line,json"], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BASE_URL: base, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
  });
  preview.kill();
  console.log(`[e2e-shard] ${project} ${shard.index}/${shard.total}: exit ${r.status ?? r.signal} → ${out}`);
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
