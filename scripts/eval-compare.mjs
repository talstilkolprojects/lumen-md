#!/usr/bin/env node
// Compare an eval run with the saved baseline for the same model (K1).
//
//   npm run eval:compare -- eval/results/agents-2026-10-18-qwen2.5_7b.json
//   npm run eval:compare -- <results.json> --save      # make it the baseline
//
// Baselines live in eval/baseline/<kind>-<model>.json (committed). A case
// that passed in the baseline and fails now is a regression: exit 1 — so is
// one that passed and is gone from the run (removed or renamed; a case the
// run marks `skipped` is exempt).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run eval:compare -- <results.json> [--save] [--baseline <file>]");
  process.exit(2);
}
const run = JSON.parse(readFileSync(file, "utf8"));
const kind = basename(file).split("-")[0]; // agents | prompts
const slug = String(run.model).replace(/[^\w.-]+/g, "_");
const bi = flags.indexOf("--baseline");
const baselinePath = bi >= 0 ? flags[bi + 1] : join("eval", "baseline", `${kind}-${slug}.json`);
// A run against scripts/fake-ollama.mjs proves the wiring only ("kind": "wiring"). Never let
// it stand in for, or be compared with, a real model's score.
const kindOf = (r) => r.kind ?? (r.model === "fake-ollama" ? "wiring" : "model");
const pass = (r) => r.status === "ok" && (r.checks ?? []).every((c) => c.ok);
const passed = new Map(run.results.filter((r) => r.status !== "skipped").map((r) => [r.id, pass(r)]));
const score = [...passed.values()].filter(Boolean).length;
console.log(`${kind} · ${run.model}: ${score}/${passed.size} passed`);

if (flags.includes("--save")) {
  mkdirSync(join("eval", "baseline"), { recursive: true });
  const slim = { model: run.model, kind: kindOf(run), date: run.date, results: run.results.map((r) => ({ id: r.id, status: r.status, checks: (r.checks ?? []).map((c) => ({ ok: c.ok })) })) };
  writeFileSync(baselinePath, JSON.stringify(slim, null, 2) + "\n");
  console.log(`baseline saved: ${baselinePath}`);
  process.exit(0);
}
if (!existsSync(baselinePath)) {
  console.log(`no baseline at ${baselinePath} — run again with --save to create it`);
  process.exit(0);
}
const base = JSON.parse(readFileSync(baselinePath, "utf8"));
if (kindOf(base) !== kindOf(run)) {
  console.error(`refusing to compare a ${kindOf(run)} run (${run.model}) with a ${kindOf(base)} baseline (${base.model}): fake-server results prove the wiring, not model quality`);
  process.exit(2);
}
const before = new Map(base.results.filter((r) => r.status !== "skipped").map((r) => [r.id, pass(r)]));
const regressions = [...passed].filter(([id, ok]) => before.get(id) === true && !ok).map(([id]) => id);
const inRun = new Set(run.results.map((r) => r.id));
const missing = [...before].filter(([id, ok]) => ok && !inRun.has(id)).map(([id]) => id);
const fixed = [...passed].filter(([id, ok]) => before.get(id) === false && ok).map(([id]) => id);
const baseScore = [...before.values()].filter(Boolean).length;
console.log(`baseline (${base.date}): ${baseScore}/${before.size} · now ${score}/${passed.size}`);
if (fixed.length) console.log(`fixed: ${fixed.join(", ")}`);
if (missing.length) console.error(`MISSING (passed in the baseline, not in this run): ${missing.join(", ")}`);
if (regressions.length) console.error(`REGRESSIONS: ${regressions.join(", ")}`);
if (regressions.length || missing.length) process.exit(1);
console.log("no regressions");
