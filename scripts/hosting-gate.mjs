#!/usr/bin/env node
/**
 * `npm run hosting:gate` (plan W6.9): fail a build that takes money while
 * production is on a plan without commercial use (scripts/lib/hostingGate.mjs).
 *
 *   node scripts/hosting-gate.mjs                         this environment (Vercel: VERCEL=1)
 *   node scripts/hosting-gate.mjs --host cloudflare-pages  a Direct Upload (scripts/pages-deploy.sh)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostingGate } from "./lib/hostingGate.mjs";

export function runGate(env = process.env, argv = process.argv.slice(2), root = resolve(fileURLToPath(new URL("..", import.meta.url)))) {
  const hosting = JSON.parse(readFileSync(resolve(root, "deploy/hosting.json"), "utf8"));
  return hostingGate(hosting, env, argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = runGate();
  if (r.ok) {
    console.log(`hosting:gate: ok (${r.host ?? "not on a host"}; ${r.commercialVars.length ? `takes payments: ${r.commercialVars.join(", ")}` : "no payments"})`);
  } else {
    for (const p of r.problems) console.error(`::error title=hosting gate::${p}`);
    process.exit(1);
  }
}
