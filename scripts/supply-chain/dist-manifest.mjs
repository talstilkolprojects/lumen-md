#!/usr/bin/env node
/**
 * Writes dist/.well-known/lumen-build.json (plan W7.23): the sha256 of every
 * file of this build, with the commit, the lockfile's hash, the Node version
 * and which infrastructure built it. Vercel runs it as the `manifest` gate
 * right after the build; Cloudflare Workers Builds runs `npm run build:repro`.
 * `two-hosts.mjs` compares the two.
 *
 *   node scripts/supply-chain/dist-manifest.mjs [--dist dist]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filesUnder, opts, sha256, sha256File } from "./lib.mjs";
import { MANIFEST_PATH, manifestOf } from "./two-hosts-lib.mjs";

export function buildHost(env = process.env) {
  if (env.VERCEL) return "vercel";
  if (env.WORKERS_CI || env.CF_PAGES) return "cloudflare";
  return env.LUMEN_BUILD_HOST || "local";
}

export function buildCommit(env = process.env, root = ".") {
  const c = env.VERCEL_GIT_COMMIT_SHA || env.WORKERS_CI_COMMIT_SHA || env.CF_PAGES_COMMIT_SHA;
  if (c) return c;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function writeManifest(root, distDir = "dist", env = process.env) {
  const dist = resolve(root, distDir);
  const entries = filesUnder(dist).map((path) => ({ path, hash: sha256File(join(dist, path)) }));
  const m = manifestOf(entries, { commit: buildCommit(env, root), lockfile: sha256(readFileSync(join(root, "package-lock.json"))), node: process.version, host: buildHost(env), builtAt: new Date().toISOString() });
  const out = join(dist, MANIFEST_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(m, null, 1) + "\n");
  return { out, files: Object.keys(m.files).length, manifest: m };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = opts(process.argv);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const r = writeManifest(root, o.get("--dist", "dist"));
  console.log(`dist-manifest: ${r.files} files, ${r.manifest.host} @ ${r.manifest.commit.slice(0, 10)} → ${r.out}`);
}
