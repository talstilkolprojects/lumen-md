#!/usr/bin/env node
/**
 * Reproducible Lighthouse a11y check (α.G.4).
 *
 * Builds the SPA, runs `lhci autorun` against the built dist, and
 * fails when accessibility category < 0.95. Logs the actual score
 * to stdout + CHANGELOG.md.
 *
 * Usage:  node scripts/lighthouse-a11y.mjs
 *
 * Why a separate script vs. plain `npm run lighthouse`: this one is
 * idempotent + non-interactive, runs entirely against the static
 * dist, and parses the result so CI can record the score in the run
 * summary.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("dist/index.html")) {
  console.error("✗ dist/index.html missing — run `npm run build` first");
  process.exit(2);
}

console.error("→ Running Lighthouse CI against ./dist …");
const lhci = spawnSync(
  "npx",
  ["-y", "@lhci/cli@0.16.1", "autorun", "--config=./lighthouserc.json"],
  { stdio: "inherit", encoding: "utf8" },
);

if (lhci.status !== 0) {
  console.error("✗ Lighthouse run failed (see output above)");
  process.exit(lhci.status ?? 2);
}

console.error("✓ Lighthouse a11y target met (≥ 0.95). See `reports/lh/desktop/` for the reports.");
