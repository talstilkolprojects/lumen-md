#!/usr/bin/env node
/**
 * The manifest of a build output (plan W7.23): every file's SHA-256 and size,
 * with the commit, lockfile, Node and platform it was built with.
 *
 *   node scripts/supply-chain/dist-manifest.mjs [--dir dist] [--builder <id>] [--out <file>] [--build-seconds N]
 *
 * Prints the JSON (or writes --out). Cloudflare Workers Builds runs it after
 * `npm run build` (scripts/supply-chain/cf-build.sh); any other host can too.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { opts, sha256 } from "./lib.mjs";
import { commitOf, manifestOf, viteEnv } from "./repro-lib.mjs";
import { sourceDate } from "./sbom.mjs";

const o = opts(process.argv);
const root = resolve(o.get("--root", "."));
const dir = resolve(root, o.get("--dir", "dist"));
const git = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
let lockfileSha256;
try {
  lockfileSha256 = sha256(readFileSync(resolve(root, "package-lock.json")));
} catch {
  lockfileSha256 = undefined;
}
const manifest = manifestOf(dir, {
  commit: commitOf(process.env, git),
  builder: o.get("--builder", process.env.WORKERS_CI ? "cloudflare-workers-builds" : process.env.VERCEL ? "vercel" : `local-${platform()}`),
  builtAt: new Date().toISOString(),
  sourceDateEpoch: Math.floor(sourceDate(root).getTime() / 1000),
  lockfileSha256,
  node: process.version,
  platform: `${platform()}-${arch()}`,
  viteEnv: viteEnv(process.env),
  ...(o.get("--build-seconds") ? { buildSeconds: Number(o.get("--build-seconds")) } : {}),
});
const json = JSON.stringify(manifest, null, 1) + "\n";
const out = o.get("--out");
if (out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), json);
  console.error(`${manifest.fileCount} files, ${manifest.bytes} bytes → ${out}`);
} else process.stdout.write(json);
