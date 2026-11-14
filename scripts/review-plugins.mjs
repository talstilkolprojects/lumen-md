#!/usr/bin/env node
/**
 * Review every plugin version in the registry and write its scorecard
 * (plan W11.S14; the rules are in src/plugins/runtime/review.ts):
 *
 *   node scripts/review-plugins.mjs                 # writes public/plugins/examples/scorecards/<id>@<version>.json
 *   node scripts/review-plugins.mjs --check         # exit 1 when a scorecard is missing or stale, a version fails,
 *                                                   # or a failing version is still listed 24 h after its review
 *   … --dir <registry dir> --out <scorecards dir>   # another registry (the tests use this)
 *
 * Runs offline: `npm audit` is not run (a version with a lockfile is marked
 * "audit owed"). Each version's previous version is the one before it in
 * index.json, for the permission diff.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
if (!process.execArgv.includes("--import")) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", pathToFileURL(join(ROOT, "scripts/lib/ts-register.mjs")).href, SELF, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const opt = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);
const { reviewPluginVersion, overdueTakedowns } = await import(pathToFileURL(join(ROOT, "src/plugins/runtime/review.ts")).href);
const DIR = resolve(opt("--dir") ?? join(ROOT, "public/plugins/examples"));
const OUT = resolve(opt("--out") ?? join(DIR, "scorecards"));
const inRepo = !opt("--dir") || args.includes("--in-repo");
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
/** A scorecard without what changes on every run. */
const stable = (c) => JSON.stringify({ ...c, reviewedAt: undefined, durationMs: undefined });

const cards = [];
const listed = [];
for (const p of index.plugins) {
  let previous;
  for (const v of p.versions) {
    const at = join(DIR, v.path);
    const manifest = readFileSync(join(at, "lumen-plugin.json"), "utf8");
    const m = JSON.parse(manifest);
    const card = await reviewPluginVersion({
      manifest,
      main: readFileSync(join(at, m.main ?? "main.js"), "utf8"),
      ...(m.ui && existsSync(join(at, m.ui)) ? { ui: readFileSync(join(at, m.ui), "utf8") } : {}),
      ...(read(join(at, "styles.css")) !== undefined ? { css: read(join(at, "styles.css")) } : {}),
      ...(read(join(at, "src/main.ts")) ?? read(join(at, "src/main.js")) ? { source: read(join(at, "src/main.ts")) ?? read(join(at, "src/main.js")) } : {}),
      ...(v.signature ? { signature: v.signature } : {}),
      ...(previous !== undefined ? { previousManifest: previous } : {}),
      hasLockfile: existsSync(join(at, "package-lock.json")) || existsSync(join(at, "pnpm-lock.yaml")),
      inRepo,
    });
    previous = manifest;
    cards.push(card);
    if (!v.delisted) listed.push({ id: p.id, version: v.version });
    console.log(`${card.passed ? "  ok" : "FAIL"} ${card.id}@${card.version}  ${card.grade} ${card.score}  ${card.durationMs} ms  ${card.findings.map((f) => `${f.severity}:${f.rule}`).join(" ") || "no findings"}`);
  }
}

const file = (c) => join(OUT, `${c.id}@${c.version}.json`);
if (args.includes("--check")) {
  const stale = cards.filter((c) => !existsSync(file(c)) || stable(JSON.parse(readFileSync(file(c), "utf8"))) !== stable(c));
  const failing = cards.filter((c) => !c.passed);
  // The takedown clock runs from the review on record, not from this run.
  const recorded = cards.map((c) => (existsSync(file(c)) ? JSON.parse(readFileSync(file(c), "utf8")) : c));
  const overdue = overdueTakedowns(listed, recorded, Date.now());
  for (const c of stale) console.log(`stale or missing: ${file(c)}`);
  for (const c of overdue) console.log(`overdue takedown (failed ${c.reviewedAt}, still listed): ${c.id}@${c.version}`);
  process.exit(stale.length || failing.length || overdue.length ? 1 : 0);
}
mkdirSync(OUT, { recursive: true });
for (const c of cards) writeFileSync(file(c), JSON.stringify(c, null, 2) + "\n");
console.log(`${cards.length} versions reviewed → ${OUT}`);
