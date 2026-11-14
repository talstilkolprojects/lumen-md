#!/usr/bin/env node
/**
 * `npm run hygiene` / `npm run check` / `npm run check:seams` (and ci:local's
 * hygiene step): every exported `register*` / `set*` hook in src/ has a
 * production caller, or an unexpired entry in scripts/seams.allow.json with
 * its reason and closing task (scripts/lib/liveSeams.mjs).
 * Exit 1 on a dead seam, a stale or expired entry, or an incomplete one.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSeams, LIVE_SEAM_EXCEPTIONS } from "./lib/liveSeams.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const t0 = performance.now();
const { seams, dead, problems } = checkSeams(join(root, "src"));
const ms = Math.round(performance.now() - t0);
for (const p of problems) console.error(`src/${p.file}:${p.line}  [${p.rule}]  ${p.text}`.replace("src/scripts/", "scripts/"));
const by = (k) => Object.values(LIVE_SEAM_EXCEPTIONS).filter((e) => e.kind === k).length;
if (problems.length) {
  console.error(`\n✖ live seams: ${problems.length} problem(s). A register*/set* hook only tests call is a feature the app never plugs in.`);
  process.exit(1);
}
console.error(`✓ live seams: ${seams.length} register*/set* hooks, ${seams.length - dead.length} with a production caller; ${dead.length} listed (${by("pending")} pending a task, ${by("test-only")} test-only, ${by("dead")} dead and named) in ${ms} ms.`);
