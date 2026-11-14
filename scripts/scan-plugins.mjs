#!/usr/bin/env node
/**
 * Scan every version in the sandboxed plugin registry (plan W1.20):
 *
 *   node scripts/scan-plugins.mjs           # writes public/plugins/examples/scan.json
 *   node scripts/scan-plugins.mjs --check   # exit 1 when scan.json is out of date or a version fails
 *
 * Each version gets the result of src/plugins/runtime/scan.ts — passed,
 * score, grade, findings — which the gallery shows as its safety card; a
 * version that fails is not shown. A new version is added to index.json
 * and scanned here before it is published.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
if (!process.execArgv.includes("--import")) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", pathToFileURL(join(ROOT, "scripts/lib/ts-register.mjs")).href, SELF, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { scanPluginVersion } = await import(pathToFileURL(join(ROOT, "src/plugins/runtime/scan.ts")).href);
const DIR = join(ROOT, "public/plugins/examples");
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const results = [];
for (const p of index.plugins) {
  for (const v of p.versions) {
    const at = join(DIR, v.path);
    const manifest = readFileSync(join(at, "lumen-plugin.json"), "utf8");
    const m = JSON.parse(manifest);
    const main = readFileSync(join(at, m.main ?? "main.js"), "utf8");
    const ui = m.ui && existsSync(join(at, m.ui)) ? readFileSync(join(at, m.ui), "utf8") : undefined;
    const r = await scanPluginVersion({ manifest, main, ...(ui !== undefined ? { ui } : {}), ...(v.signature ? { signature: v.signature } : {}) });
    if (r.id !== p.id || r.version !== v.version) r.findings.push({ rule: "manifest", severity: "error", detail: `index.json says ${p.id}@${v.version}, the manifest ${r.id}@${r.version}` });
    results.push({ ...r, passed: r.passed && r.id === p.id && r.version === v.version, path: v.path });
  }
}
const out = JSON.stringify({ scanner: 1, results }, null, 2) + "\n";
const file = join(DIR, "scan.json");
for (const r of results) console.log(`${r.passed ? "  ok" : "FAIL"} ${r.id}@${r.version}  ${r.grade} ${r.score}  ${r.findings.map((f) => `${f.severity}:${f.rule}${f.detail ? `(${f.detail})` : ""}`).join(" ") || "no findings"}`);
if (process.argv.includes("--check")) {
  const stale = !existsSync(file) || readFileSync(file, "utf8") !== out;
  if (stale) console.log("scan.json is out of date: run node scripts/scan-plugins.mjs");
  process.exit(stale || results.some((r) => !r.passed) ? 1 : 0);
}
writeFileSync(file, out);
console.log(`${results.length} versions scanned → ${file}`);
