#!/usr/bin/env node
/**
 * CI health check of the deployed collab endpoints (plan 3.6.3).
 *
 *   SIGNAL_URL=wss://signal.example COLLAB_URL=wss://collab.example node scripts/collab-health.mjs
 *
 * Exit 1 when a configured endpoint is unhealthy. With neither variable
 * set (not deployed yet, owner action 15.4) it reports "skipped" and exits 0.
 */
import { checkCollabHealth } from "./lib/collabHealth.mjs";

const signalUrl = process.env.SIGNAL_URL?.trim() || "";
const collabUrl = process.env.COLLAB_URL?.trim() || "";
const { skipped, results } = await checkCollabHealth({ signalUrl, collabUrl });
if (skipped) {
  console.log("Skipped: neither SIGNAL_URL nor COLLAB_URL is configured (deploy pending, owner action 15.4).");
  process.exit(0);
}
let failed = false;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name} healthy (${r.url})`);
  else {
    failed = true;
    console.error(`::error::${r.name} unhealthy (${r.url}): ${r.error}`);
  }
}
process.exit(failed ? 1 : 0);
