#!/usr/bin/env node
/**
 * Reproducible build check (plan W1.27): build the same commit twice from
 * clean and compare the SHA-256 of every file in dist/.
 *
 *   node scripts/supply-chain/repro-check.mjs [--build "npm run build"] [--keep]
 *
 * SOURCE_DATE_EPOCH is set to the commit time for both builds. Prints each
 * file that differs (and files only one build has); exit code 1 if any.
 *
 * Source maps (plan W4.16): a release ships none (plan 11.5; `npm run budget`
 * fails a build that has one), so a release build must have 0 `.map` files —
 * that is checked here too, and is how two builds give byte-identical maps.
 * W1.27's base still emitted maps, and 2–3 of them (sql-wasm, sw.js,
 * pdf.worker) differed run to run. `--sourcemap` builds with
 * LUMEN_SOURCEMAP=1 (local investigation only) and, for each map that
 * differs, says which of its fields do (sources, sourcesContent, mappings…),
 * to find what is not deterministic there.
 */
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { filesUnder, opts, sha256File } from "./lib.mjs";
import { sourceDate } from "./sbom.mjs";

const o = opts(process.argv);
const root = resolve(o.get("--root", "."));
const build = o.get("--build", "npm run build");
const withMaps = o.has("--sourcemap");
const env = { ...process.env, SOURCE_DATE_EPOCH: String(Math.floor(sourceDate(root).getTime() / 1000)), TZ: "UTC", LC_ALL: "C", ...(withMaps ? { LUMEN_SOURCEMAP: "1" } : {}) };
const work = mkdtempSync(join(tmpdir(), "lumen-repro-"));
const snapshots = [];
for (const n of [1, 2]) {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  console.log(`build ${n}: ${build}`);
  execSync(build, { cwd: root, env, stdio: "inherit" });
  const copy = join(work, `dist-${n}`);
  cpSync(join(root, "dist"), copy, { recursive: true });
  snapshots.push(new Map(filesUnder(copy).map((p) => [p, sha256File(join(copy, p))])));
}
const [a, b] = snapshots;
const diff = [];
for (const p of new Set([...a.keys(), ...b.keys()])) {
  if (a.get(p) !== b.get(p)) diff.push(!a.has(p) ? `only in build 2: ${p}` : !b.has(p) ? `only in build 1: ${p}` : `differs: ${p}`);
}
// Which fields of a differing source map differ (with --sourcemap).
const mapFields = (p) => {
  try {
    const x = JSON.parse(readFileSync(join(work, "dist-1", p), "utf8"));
    const y = JSON.parse(readFileSync(join(work, "dist-2", p), "utf8"));
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  } catch {
    return ["(not JSON)"];
  }
};
const maps = [...a.keys()].filter((p) => p.endsWith(".map"));
if (withMaps) {
  for (const d of diff) {
    const p = d.replace(/^differs: /, "");
    if (d.startsWith("differs: ") && p.endsWith(".map")) console.log(`  ${p}: differs in ${mapFields(p).join(", ")}`);
  }
} else if (maps.length) {
  console.log(`SOURCE MAPS IN A RELEASE BUILD: ${maps.length} (plan 11.5 allows none)\n  ${maps.sort().join("\n  ")}`);
}
if (!o.has("--keep")) rmSync(work, { recursive: true, force: true });
console.log(diff.length ? `NOT REPRODUCIBLE: ${diff.length} of ${a.size} files\n  ${diff.sort().join("\n  ")}` : `REPRODUCIBLE: ${a.size} files, same SHA-256 in both builds`);
process.exit(diff.length || (!withMaps && maps.length) ? 1 : 0);
