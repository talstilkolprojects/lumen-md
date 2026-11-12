#!/usr/bin/env node
/**
 * Pagefind on the built docs site (plan W4.34).
 *
 *   node scripts/docs-pagefind.mjs [--site docs/dist] [--force]
 *
 * `astro build` already runs Pagefind: Starlight's search integration
 * indexes the site into docs/dist/pagefind/. This script is the safety net
 * for builds where that did not happen — Pagefind's npm package fetches a
 * platform binary as an optional dependency, which some installs skip — and
 * the way to re-index without a rebuild (--force). It runs the Pagefind
 * release binary from GitHub, the same version as the docs' lockfile
 * (PAGEFIND_VERSION), after checking its SHA-256 against the release's
 * published checksum (pinned below), cached in node_modules/.cache.
 *
 * Then `node scripts/docs-search.mjs --site docs/dist` runs the 20 golden
 * Hebrew queries against that index in a browser.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PAGEFIND_VERSION = "1.5.2";

/** The release asset for each platform, with the SHA-256 published next to it on the release page. */
export const ASSETS = {
  "linux-x64": { target: "x86_64-unknown-linux-musl", sha256: "afb824a9e7f64905a934900481cea5be679c03975e527329e0e5e6cc70f5feda" },
  "linux-arm64": { target: "aarch64-unknown-linux-musl", sha256: "f50ec608bcbf431cebd84e0efa3a5b041ee63df2ad81f138023e0cfd2f509424" },
  "darwin-x64": { target: "x86_64-apple-darwin", sha256: "26f51b4ba921897142338fb13b836420696e251fe197b1782ea7981de311156d" },
  "darwin-arm64": { target: "aarch64-apple-darwin", sha256: "7286f394a349bd37677d44a65a20078a02b1747da0b0814d83403bf86be17abe" },
  "win32-x64": { target: "x86_64-pc-windows-msvc", sha256: "fab125d5e8e2d3481ffe7d36dec6e101f54a6581cd51cf5e2e09220d4bc78e9c" },
};

/** The download URL and checksum for a platform; null when Pagefind publishes no binary for it. */
export function releaseAsset(platform, arch, version = PAGEFIND_VERSION) {
  const a = ASSETS[`${platform}-${arch}`];
  if (!a) return null;
  const file = `pagefind-v${version}-${a.target}.tar.gz`;
  return { file, url: `https://github.com/CloudCannon/pagefind/releases/download/v${version}/${file}`, sha256: a.sha256, exe: platform === "win32" ? "pagefind.exe" : "pagefind" };
}

/** Is the site already indexed (Starlight ran Pagefind during `astro build`)? */
export function indexed(site) {
  return existsSync(join(site, "pagefind", "pagefind.js")) && existsSync(join(site, "pagefind", "pagefind-entry.json"));
}

function download(url, to) {
  // curl honours the system's proxy settings; Node's fetch does not.
  const r = spawnSync("curl", ["-fsSL", "--retry", "2", "-o", to, url], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`could not download ${url}`);
}

async function binary(root) {
  const asset = releaseAsset(process.platform, process.arch);
  if (!asset) throw new Error(`Pagefind publishes no binary for ${process.platform}-${process.arch}`);
  const dir = join(root, "node_modules", ".cache", `pagefind-${PAGEFIND_VERSION}`);
  const exe = join(dir, asset.exe);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const tgz = join(dir, asset.file);
  download(asset.url, tgz);
  const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  if (got !== asset.sha256) {
    writeFileSync(tgz, "");
    throw new Error(`${asset.file}: SHA-256 ${got}, expected ${asset.sha256} — not running it`);
  }
  const x = spawnSync("tar", ["-xzf", tgz, "-C", dir], { stdio: "inherit" });
  if (x.status !== 0 || !existsSync(exe)) throw new Error(`could not unpack ${asset.file}`);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  return exe;
}

async function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const at = process.argv.indexOf("--site");
  const site = resolve(at > 0 ? process.argv[at + 1] : join(root, "docs", "dist"));
  if (!existsSync(join(site, "index.html")) && !existsSync(join(site, "he"))) {
    console.error(`✗ ${site} is not a built site: run the docs build first (npm run docs:build)`);
    process.exit(1);
  }
  if (indexed(site) && !process.argv.includes("--force")) {
    console.error(`✓ ${site} already has its Pagefind index (from astro build)`);
    return;
  }
  const exe = await binary(root);
  const r = spawnSync(exe, ["--site", site], { stdio: "inherit" });
  if (r.status !== 0 || !indexed(site)) process.exit(r.status || 1);
  console.error(`✓ Pagefind ${PAGEFIND_VERSION} indexed ${site}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
