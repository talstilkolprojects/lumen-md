#!/usr/bin/env node
/**
 * Score every capability on the held-out test split, in CI (plan 7.1).
 *
 *   node scripts/golden/run-evals.mjs --dir DIR [--out scores.json]
 *
 * DIR is the CI-built test split. Each set's harness, when its feature task
 * has written one, is scripts/golden/evals/<set>.mjs exporting
 *   score({ items, manifest, corpus }) → { <metric>: number, … }
 * (items and corpus — part id → documents — as loadSet returns them). Only those numbers are published — to
 * scores.json and the job summary; no item, input or output is printed. A
 * test part whose sha256 does not match the manifest fails the set; a set
 * with a part below its declared test count is "partial" and not scored.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { incompleteParts, loadSet, publicHarnessError, publicLoaderError, validateAll } from "../lib/golden.mjs";
import { GOLDEN, ROOT } from "./common.mjs";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const dir = opt("--dir");
const outFile = opt("--out") ?? "scores.json";
if (!dir) {
  console.error("usage: run-evals.mjs --dir <test split> [--out scores.json]");
  process.exit(2);
}

const sets = {};
let failed = false;
for (const { name, manifest } of validateAll(GOLDEN)) {
  const harness = join(ROOT, "scripts", "golden", "evals", `${name}.mjs`);
  try {
    const { items, unverified, corpus } = loadSet(GOLDEN, name, { split: "test", testDir: dir });
    const parts = Object.fromEntries(manifest.parts.map((p) => [p.id, items.filter((it) => it.part === p.id).length]));
    if (!items.length) {
      sets[name] = { status: "not-built", parts };
      continue;
    }
    // Every part at its declared size, or no score: a metric over a partial
    // set (say FLEURS only, without Common Voice) would be published as the set's.
    const missing = incompleteParts(manifest, items);
    if (missing.length) {
      sets[name] = { status: "partial", parts, note: `not scored: ${missing.map((m) => `${m.part} ${m.have}/${m.want}`).join(", ")}` };
      continue;
    }
    if (!existsSync(harness)) {
      sets[name] = { status: "no-harness", parts, unverified, note: `scripts/golden/evals/${name}.mjs is written by the feature task (${manifest.capability})` };
      continue;
    }
    const mod = await import(pathToFileURL(harness).href);
    let raw;
    try {
      raw = await mod.score({ items, manifest, corpus });
    } catch (e) {
      // Never the harness's message: it can quote held-out data (publicHarnessError).
      failed = true;
      sets[name] = { status: "error", error: publicHarnessError(e) };
      continue;
    }
    const scores = Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
    sets[name] = { status: "scored", parts, unverified, scores };
  } catch (e) {
    failed = true;
    // Never the loader's raw message: a JSON.parse error quotes held-out text.
    sets[name] = { status: "error", error: publicLoaderError(e) };
  }
}

const report = { generatedAt: new Date().toISOString(), split: "test", sets };
writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
const lines = ["## Golden sets — test split", "", "| Set | Status | Items per part | Scores |", "|---|---|---|---|"];
for (const [name, r] of Object.entries(sets)) lines.push(`| ${name} | ${r.status}${r.unverified?.length ? ` (sha256 not recorded: ${r.unverified.join(", ")})` : ""} | ${r.parts ? Object.entries(r.parts).map(([p, n]) => `${p} ${n}`).join(", ") : ""} | ${r.scores ? Object.entries(r.scores).map(([k, v]) => `${k} ${v}`).join(", ") : (r.error ?? (r.status === "partial" ? r.note : ""))} |`);
const md = lines.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
process.exit(failed ? 1 : 0);
