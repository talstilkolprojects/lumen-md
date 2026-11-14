#!/usr/bin/env node
/**
 * Fail when the installed dependencies are not the ones package-lock.json
 * names (W8.9). The train's first gate (scripts/vercel-build.mjs) and the
 * lanes' pre-push check run it.
 *
 *   node scripts/lockfile-drift.mjs              npm ls --all against the lockfile, and
 *                                                package.json against the lockfile's root
 *   node scripts/lockfile-drift.mjs --lock-only  only package.json against the lockfile
 *                                                (no node_modules needed: offline pre-push)
 *   node scripts/lockfile-drift.mjs --tree <dir> also compare the hoisted packages of
 *                                                another node_modules a tool resolves from
 *                                                (an offline test shim); a finding there is
 *                                                printed, and fails only with --strict-tree
 *   --omit-dev                                   a tree installed without devDependencies
 *   --root <dir>                                 the project (default: this checkout)
 *
 * Exit 0: no drift. Exit 1: drift, one line per package. Exit 2: could not check
 * (no node_modules, npm ls gave no JSON), which is a failure too, never a pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeDrift, flattenNpmLs, lockDrift, manifestDrift, treeDrift } from "./lib/lockfile-drift.mjs";

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] ?? "" : null;
};
const flag = (n) => argv.includes(`--${n}`);
const root = resolve(opt("root") ?? fileURLToPath(new URL("..", import.meta.url)));
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

function main() {
  const lock = readJson(join(root, "package-lock.json"));
  const pkg = readJson(join(root, "package.json"));
  const findings = manifestDrift(pkg, lock);
  let checked = "package.json against the lockfile's root entry";

  if (!flag("lock-only")) {
    if (!existsSync(join(root, "node_modules"))) {
      console.error(`✗ lockfile-drift: ${root}/node_modules does not exist; run npm ci first (or --lock-only).`);
      return 2;
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // npm ls exits 1 on its own range problems (an invalid peer, an extraneous
    // package) but still prints the tree; the comparison below is the verdict.
    const r = spawnSync(npm, ["ls", "--all", "--json", "--long"], { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    let tree;
    try {
      tree = JSON.parse(r.stdout);
    } catch {
      console.error(`✗ lockfile-drift: npm ls --all gave no JSON (exit ${r.status ?? r.signal}): ${(r.stderr || "").trim().slice(0, 400)}`);
      return 2;
    }
    const installed = flattenNpmLs(tree, root);
    findings.push(...lockDrift(lock, installed, { omitDev: flag("omit-dev") }));
    checked = `${installed.size} installed packages (npm ls --all) and ${checked}`;
  }

  const tree = opt("tree");
  let treeFindings = [];
  if (tree) {
    const dir = resolve(tree);
    treeFindings = treeDrift(lock, (name) => {
      try {
        return readJson(join(dir, name, "package.json")).version ?? null;
      } catch {
        return null; // why: the tree does not have it; importing it there fails loudly, which is not drift
      }
    });
    for (const d of treeFindings) console.log(`${flag("strict-tree") ? "✗" : "⚠"} ${dir}: ${describeDrift(d)}`);
    if (!treeFindings.length) console.log(`✓ lockfile-drift: ${dir} holds no package at a version the lockfile does not name`);
  }

  for (const d of findings) console.error(`✗ ${describeDrift(d)}`);
  if (findings.length || (flag("strict-tree") && treeFindings.length)) {
    console.error(`✗ lockfile-drift: ${findings.length + (flag("strict-tree") ? treeFindings.length : 0)} difference(s). Reinstall with npm ci; if package.json changed, regenerate the lockfile (npm install --package-lock-only) and commit it.`);
    return 1;
  }
  console.log(`✓ lockfile-drift: ${checked} match package-lock.json`);
  return 0;
}

process.exitCode = main();
