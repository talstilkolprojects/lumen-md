#!/usr/bin/env node
/**
 * The plugin registry as its own static site, for Cloudflare Pages (plan W6.35).
 *
 *   node scripts/registry-site.mjs [--out dist-registry]   # build (after build-plugin-registry --check passes)
 *   node scripts/registry-site.mjs --verify dist-registry  # check a built folder: hashes, SHA256SUMS, a fresh scan
 *   node scripts/registry-site.mjs --verify https://…      # the same against the hosted site
 *
 * Deploy (owner, once `wrangler login` is done):
 *   npx wrangler pages deploy dist-registry --project-name lumen-md-plugins --branch main
 * See docs/src/content/docs/plugins/registry.md, "A registry site of its own".
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSite, pagesProblems, verifySite } from "./lib/registrySite.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
if (!process.execArgv.includes("--import")) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", pathToFileURL(join(ROOT, "scripts/lib/ts-register.mjs")).href, SELF, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const { scanPluginVersion } = await import(pathToFileURL(join(ROOT, "src/plugins/runtime/scan.ts")).href);
const argv = process.argv.slice(2);
const DIR = join(ROOT, "public/plugins/examples");

if (argv.includes("--verify")) {
  const target = argv[argv.indexOf("--verify") + 1] ?? "dist-registry";
  const remote = /^https:\/\//.test(target);
  const get = async (p) => {
    if (!remote) {
      const f = join(resolve(target), p);
      return existsSync(f) ? readFileSync(f) : null;
    }
    const res = await fetch(new URL(p, target.endsWith("/") ? target : target + "/"), { redirect: "follow" });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  };
  const r = await verifySite({ get, scanVersion: scanPluginVersion });
  for (const p of r.problems) console.log(`FAIL ${p}`);
  console.log(`${r.ok ? "ok" : "FAILED"}: ${r.versions} versions checked in ${target}`);
  process.exit(r.ok ? 0 : 1);
}

const fresh = spawnSync(process.execPath, [join(ROOT, "scripts/build-plugin-registry.mjs"), "--check"], { encoding: "utf8" });
if (fresh.status !== 0) {
  process.stdout.write(fresh.stdout ?? "");
  console.log("FAIL the registry is out of date or a version fails its scan: run node scripts/build-plugin-registry.mjs");
  process.exit(1);
}
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  /* why: not a git checkout — the index says so with null */
}
const site = buildSite({
  index: JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")),
  scan: JSON.parse(readFileSync(join(DIR, "scan.json"), "utf8")),
  read: (path, file) => readFileSync(join(DIR, path, file)),
  commit,
});
const limits = pagesProblems(site.files);
for (const p of limits) console.log(`FAIL Pages limit: ${p}`);
if (limits.length) process.exit(1);
const out = resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(ROOT, "dist-registry"));
rmSync(out, { recursive: true, force: true });
for (const [p, buf] of site.files) {
  mkdirSync(dirname(join(out, p)), { recursive: true });
  writeFileSync(join(out, p), buf);
}
for (const s of site.skipped) console.log(`skip ${s}`);
const versions = site.index.plugins.reduce((n, p) => n + p.versions.length, 0);
console.log(`${site.index.plugins.length} plugins, ${versions} versions, ${site.files.size} files → ${out}`);
