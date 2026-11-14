#!/usr/bin/env node
/**
 * The ACR's automated part (plan W3.8): an axe-core run, turned into
 * docs/acr/axe.json, which scripts/acr.mjs reads. Each WCAG success
 * criterion then shows what axe checked for it, and a criterion axe finds
 * violations of can't be reported as "supports".
 *
 *   node scripts/acr-axe.mjs <results…> [--source TEXT] [--commit SHA] [--date YYYY-MM-DD] [--out docs/acr/axe.json]
 *
 * <results> are files with axe runs, in either form:
 * - JSON {version, runs, tags} (e2e/acr-axe.spec.ts writes test-results/acr-axe.json);
 * - a log whose lines start with "AXE " followed by that JSON (one line per
 *   batch, as the offline component harness prints them).
 * A run is {surface, lang, theme, passes: [rule], incomplete: [rule],
 * violations: [{id, impact, nodes}]}; `tags` maps each rule to its axe tags.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const AXE_FILE = "docs/acr/axe.json";

/** axe's WCAG tags ("wcag143", "wcag1410", "wcag2411") → success criteria ("1.4.3", "1.4.10", "2.4.11"). */
export function criteriaOf(tags) {
  const out = [];
  for (const t of tags ?? []) {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(t);
    if (m) out.push(`${m[1]}.${m[2]}.${Number(m[3])}`);
  }
  return [...new Set(out)];
}

/** The batches in a results file (JSON, or "AXE {…}" lines). */
export function parseResults(text) {
  const t = text.trim();
  if (t.startsWith("{")) return [JSON.parse(t)];
  return t
    .split("\n")
    .filter((l) => l.startsWith("AXE "))
    .map((l) => JSON.parse(l.slice(4)));
}

/** The batches → the summary scripts/acr.mjs reads. */
export function summarize(batches, meta) {
  const version = batches.find((b) => b.version)?.version ?? null;
  if (!version) throw new Error("no axe version in the results");
  if (batches.some((b) => b.version && b.version !== version)) throw new Error("the results mix axe versions");
  const tags = Object.assign({}, ...batches.map((b) => b.tags ?? {}));
  const runs = batches.flatMap((b) => b.runs ?? []);
  if (!runs.length) throw new Error("no axe runs in the results");
  const rules = {};
  const rule = (id) => {
    if (!tags[id]) throw new Error(`no tags for rule ${id}: include the batch with the tags`);
    return (rules[id] ??= { criteria: criteriaOf(tags[id]), pass: 0, fail: 0, incomplete: 0, failures: [] });
  };
  for (const r of runs) {
    const setup = `${r.lang}/${r.theme}`;
    for (const id of r.passes ?? []) rule(id).pass++;
    for (const id of r.incomplete ?? []) rule(id).incomplete++;
    for (const v of r.violations ?? []) {
      const x = rule(v.id);
      x.fail++;
      x.failures.push({ surface: r.surface, setup, impact: v.impact ?? null, nodes: v.nodes });
    }
  }
  const sorted = Object.fromEntries(Object.keys(rules).sort().map((k) => [k, rules[k]]));
  return {
    tool: "axe-core",
    version,
    date: meta.date,
    commit: meta.commit,
    source: meta.source,
    setups: [...new Set(runs.map((r) => `${r.lang}/${r.theme}`))],
    surfaces: [...new Set(runs.map((r) => r.surface))],
    notRun: [...new Set(batches.flatMap((b) => b.failed ?? []))],
    runs: runs.length,
    rules: sorted,
  };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const files = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!files.length) {
    console.error("usage: node scripts/acr-axe.mjs <results…> [--source TEXT] [--commit SHA] [--date YYYY-MM-DD] [--out docs/acr/axe.json]");
    process.exit(2);
  }
  const commit = flag("--commit") ?? spawnSync("git", ["-C", ROOT, "rev-parse", "--short=10", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const out = summarize(
    files.flatMap((f) => parseResults(readFileSync(f, "utf8"))),
    { date: flag("--date") ?? new Date().toISOString().slice(0, 10), commit, source: flag("--source") ?? "axe-core in Chromium" },
  );
  const dest = resolve(ROOT, flag("--out") ?? AXE_FILE);
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  const fails = Object.entries(out.rules).filter(([, r]) => r.fail);
  console.error(`wrote ${join(".", dest.slice(ROOT.length))}: axe ${out.version}, ${out.runs} runs on ${out.surfaces.length} surfaces × ${out.setups.length} setups, ${Object.keys(out.rules).length} rules, ${fails.length} with violations${fails.length ? ` (${fails.map(([id]) => id).join(", ")})` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
