#!/usr/bin/env node
/**
 * `npm run hygiene` (with check-code-hygiene and audit-lock): every exported
 * `register*` / `set*` hook in src/ has a production caller, or an entry in
 * LIVE_SEAM_EXCEPTIONS with its reason (scripts/lib/liveSeams.mjs).
 * Exit 1 on a dead seam or a stale entry.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSeams, LIVE_SEAM_EXCEPTIONS } from "./lib/liveSeams.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { seams, dead, problems } = checkSeams(join(root, "src"));
for (const p of problems) console.error(`src/${p.file}:${p.line}  [${p.rule}]  ${p.text}`.replace("src/scripts/", "scripts/"));
const by = (k) => Object.values(LIVE_SEAM_EXCEPTIONS).filter((e) => e.kind === k).length;
if (problems.length) {
  console.error(`\n✖ live seams: ${problems.length} problem(s). A register*/set* hook only tests call is a feature the app never plugs in.`);
  process.exit(1);
}
console.error(`✓ live seams: ${seams.length} register*/set* hooks, ${seams.length - dead.length} with a production caller; ${dead.length} listed (${by("pending")} pending a task, ${by("test-only")} test-only, ${by("dead")} dead and named).`);
