#!/usr/bin/env node
/**
 * Max-lines gate (plan W6.25): no production file under src/ passes 800
 * lines, and the files that already did may not grow. Their counts are in
 * scripts/max-lines-baseline.json, which only ever goes down
 * (scripts/lib/maxLines.mjs has the rules).
 *
 *   node scripts/check-max-lines.mjs            check (part of `npm run hygiene`)
 *   node scripts/check-max-lines.mjs --shrink   lower the baseline after a split
 *                                               (never raises an entry or adds a file)
 *
 * Exit 1 when a file grew past its baseline, a new file passed 800 lines, or
 * the baseline is stale (a listed file shrank or is gone: run --shrink).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_PATH, checkMaxLines, describeProblems, MAX_LINES, productionLineCounts, shrinkBaseline } from "./lib/maxLines.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const file = join(root, BASELINE_PATH);
  const baseline = JSON.parse(readFileSync(file, "utf8"));
  const counts = productionLineCounts(root);
  if (process.argv.includes("--shrink")) {
    const next = shrinkBaseline(baseline, counts);
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    const before = Object.values(baseline.files).reduce((a, b) => a + b, 0);
    const after = Object.values(next.files).reduce((a, b) => a + b, 0);
    console.error(`max-lines baseline: ${Object.keys(baseline.files).length} → ${Object.keys(next.files).length} files, ${before} → ${after} lines.`);
  }
  const result = checkMaxLines(counts, JSON.parse(readFileSync(file, "utf8")));
  const problems = describeProblems(result);
  for (const p of problems) console.error(`[max-lines]  ${p}`);
  const listed = Object.keys(JSON.parse(readFileSync(file, "utf8")).files).length;
  if (problems.length) {
    console.error(`\n✖ max lines: ${problems.length} problem(s). ${listed} file(s) over ${MAX_LINES} lines are grandfathered in ${BASELINE_PATH} and may only shrink.`);
    process.exit(1);
  }
  console.error(`✓ max lines: ${Object.keys(counts).length} production files; none new over ${MAX_LINES}, and the ${listed} grandfathered in ${BASELINE_PATH} did not grow.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
