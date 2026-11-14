#!/usr/bin/env node
/**
 * Two clean builds of one commit that differ in everything a build must not
 * depend on, then a file-by-file comparison (plan W7.23). The local half of
 * "the same hash on two infrastructures": if this fails, Cloudflare and Vercel
 * cannot agree either.
 *
 *   node scripts/supply-chain/repro-two-paths.mjs [--build "npm run build"] [--install "npm ci"]
 *        [--link-node-modules] [--commit <rev>] [--keep] [--ledger f.jsonl]
 *
 * Build A and build B differ in:
 *   - the checkout's absolute path (a short one and a long nested one, with a space);
 *   - every source file's modification time (B's are set to 2001-09-09);
 *   - TZ (UTC vs Pacific/Kiritimati, +14 h), LANG/LC_ALL (C vs he_IL.UTF-8), umask (022 vs 077);
 *   - the wall clock: B runs under `faketime +400d` when faketime is installed, and
 *     otherwise simply later.
 * SOURCE_DATE_EPOCH is the commit time in both (reproducible-builds.org practice).
 *
 * Each checkout is a detached `git worktree` of --commit (default HEAD), so
 * uncommitted changes are not built. --link-node-modules links this checkout's
 * node_modules instead of running --install in each (faster; same packages).
 * Exit 0 when identical, 1 when not.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { filesUnder, opts, sha256 } from "./lib.mjs";
import { compareManifests, formatComparison, manifestOf } from "./repro-lib.mjs";

const o = opts(process.argv);
const root = resolve(o.get("--root", "."));
const build = o.get("--build", "npm run build");
const install = o.get("--install", "npm ci");
const linkModules = o.has("--link-node-modules");
const commit = execFileSync("git", ["rev-parse", o.get("--commit", "HEAD")], { cwd: root, encoding: "utf8" }).trim();
const epoch = execFileSync("git", ["log", "-1", "--format=%ct", commit], { cwd: root, encoding: "utf8" }).trim();
const haveFaketime = spawnSync("sh", ["-c", "command -v faketime"], { encoding: "utf8" }).status === 0;
const work = mkdtempSync(join(tmpdir(), "lumen-repro2-"));
const variants = [
  { id: "A", dir: join(work, "a"), env: { TZ: "UTC", LANG: "C", LC_ALL: "C" }, umask: "022", mtime: null, faketime: null },
  { id: "B", dir: join(work, "a much longer path", "with", "nested", "dirs", "b"), env: { TZ: "Pacific/Kiritimati", LANG: "he_IL.UTF-8", LC_ALL: "he_IL.UTF-8" }, umask: "077", mtime: new Date("2001-09-09T01:46:40Z"), faketime: haveFaketime ? "+400d" : null },
];

const sh = (cmd, cwd, env, umask, faketime) => {
  const line = `umask ${umask} && ${faketime ? `faketime -f ${faketime} ` : ""}sh -c ${JSON.stringify(cmd)}`;
  console.log(`  [${cwd}] ${line}`);
  const r = spawnSync("sh", ["-c", line], { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`failed (${r.status}): ${cmd}`);
};

const manifests = [];
try {
  for (const v of variants) {
    console.log(`\n== build ${v.id}: ${v.dir}`);
    mkdirSync(join(v.dir, ".."), { recursive: true });
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", v.dir, commit], { cwd: root, stdio: "inherit" });
    if (v.mtime) for (const p of filesUnder(v.dir)) utimesSync(join(v.dir, p), v.mtime, v.mtime);
    const env = { ...v.env, SOURCE_DATE_EPOCH: epoch };
    if (linkModules && existsSync(join(root, "node_modules"))) symlinkSync(resolve(root, "node_modules"), join(v.dir, "node_modules"), "dir");
    else if (install) sh(install, v.dir, env, v.umask, null);
    sh(build, v.dir, env, v.umask, v.faketime);
    let lockfileSha256;
    try {
      lockfileSha256 = sha256(readFileSync(join(v.dir, "package-lock.json")));
    } catch {
      lockfileSha256 = undefined;
    }
    manifests.push(manifestOf(join(v.dir, o.get("--dist", "dist")), { commit, builder: `local-${v.id}`, node: process.version, lockfileSha256 }));
  }
  const r = compareManifests(manifests[0], manifests[1]);
  console.log(`\n${formatComparison(r, "build A", "build B")}`);
  if (!haveFaketime) console.log("note  faketime is not installed: build B ran later on the same clock instead of 400 days ahead");
  if (o.get("--ledger")) writeFileSync(o.get("--ledger"), JSON.stringify({ at: new Date().toISOString(), commit, kind: "two-paths", identical: r.identical, same: r.same, total: r.total, differs: r.differs.map((d) => d.path) }) + "\n", { flag: "a" });
  process.exitCode = r.identical ? 0 : 1;
} finally {
  if (o.has("--keep")) console.log(`kept: ${work} (remove with: git worktree remove --force <dir>, for both)`);
  else {
    for (const v of variants) if (existsSync(v.dir)) spawnSync("git", ["worktree", "remove", "--force", v.dir], { cwd: root });
    rmSync(work, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: root });
  }
}
