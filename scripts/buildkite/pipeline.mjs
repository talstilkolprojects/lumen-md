#!/usr/bin/env node
/**
 * .buildkite/pipeline.yml from .github/workflows/ci.yml (plan W7.21).
 *
 *   npm run ci:pipeline              --check: the gate list, the pipeline's rules, and that the committed file is current
 *   npm run ci:pipeline -- --write   regenerate .buildkite/pipeline.yml
 *   node scripts/buildkite/pipeline.mjs --check --ci-json ci.json   (ci.yml already parsed, for a machine without node_modules)
 *
 * Exit 1 when a ci.yml gate is missing from the pipeline, a rule is broken
 * (soft_fail, a retry on a test failure, WebKit off the Mac, a gate with no
 * commit status), vite.config.ts's test include changed, or the committed
 * file differs from what ci.yml gives.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VITEST_INCLUDE, buildPipeline, gateCoverage, pipelineRules, pipelineYaml } from "./lib.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = join(root, ".buildkite/pipeline.yml");

async function loadCi() {
  const json = opt("ci-json");
  if (json) return JSON.parse(readFileSync(json, "utf8"));
  const text = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  // ci.yml repeats `env:` on its Build step; GitHub keeps the last one, and so does this parse.
  const { parse } = await import("yaml");
  return parse(text, { uniqueKeys: false });
}

const ci = await loadCi();
const problems = [];
const cov = gateCoverage(ci);
problems.push(...cov.problems);
let text = null;
try {
  problems.push(...pipelineRules(buildPipeline(ci)));
  text = pipelineYaml(ci);
} catch (e) {
  problems.push(String(e.message ?? e));
}
const vite = readFileSync(join(root, "vite.config.ts"), "utf8");
for (const g of VITEST_INCLUDE) if (!vite.includes(`"${g}"`)) problems.push(`vite.config.ts's test include no longer has "${g}": update VITEST_INCLUDE in scripts/buildkite/lib.mjs`);

if (argv.includes("--write") && text) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote .buildkite/pipeline.yml (${text.split("\n").length} lines)`);
} else if (text) {
  const now = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  if (now !== text) problems.push(".buildkite/pipeline.yml is not what ci.yml gives: run `npm run ci:pipeline -- --write` and commit it");
}
console.log(`ci.yml: ${cov.mapped.length} gate steps run by the pipeline, ${cov.excluded.length} setup/report steps left out with a reason`);
if (argv.includes("--list")) {
  for (const m of cov.mapped) console.log(`  run      ${m.id} → ${m.key}`);
  for (const x of cov.excluded) console.log(`  not run  ${x.id}: ${x.reason}`);
}
for (const p of problems) console.error(`✗ ${p}`);
if (!problems.length) console.log("✓ every ci.yml gate is in .buildkite/pipeline.yml, and the file is current");
process.exit(problems.length ? 1 : 0);
