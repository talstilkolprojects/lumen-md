#!/usr/bin/env node
/**
 * Did Vercel and Cloudflare build the same bytes? (plan W7.23)
 *
 *   node scripts/supply-chain/two-hosts.mjs --a https://lumen-md.vercel.app --b https://lumen-md-repro.<account>.workers.dev
 *        [--verify-fetch] [--history reports/two-hosts/history.json] [--out reports/two-hosts] [--diffoscope]
 *
 * --a / --b: a deployed site (its /.well-known/lumen-build.json) or a local
 * dist directory. --verify-fetch downloads every file from each site and
 * checks it against that site's manifest, so a host that serves other bytes
 * than it built is caught too. --diffoscope downloads each differing file from
 * both and runs diffoscope on it (the second host has it). The result goes to
 * <out>/<commit>.json, the streak to the history file, and an identical build
 * gets an in-toto statement <out>/<commit>.intoto.json for W7.22.
 * Exit 0: identical; 1: files differ; 2: not comparable (commits differ, a
 * host is down, or a served file is not what its manifest says).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { opts, sha256 } from "./lib.mjs";
import { MANIFEST_PATH, attestation, compareManifests, reportLines, streak, withResult } from "./two-hosts-lib.mjs";

const isUrl = (s) => /^https?:\/\//.test(s);

async function getBytes(src, path) {
  if (!isUrl(src)) return readFileSync(join(src, path));
  // privacy-ledger: a maintainer's script (not the app): the two deployments of this repo, nothing else.
  const res = await fetch(new URL(path, src.replace(/\/?$/, "/")), { redirect: "manual" });
  if (!res.ok) throw new Error(`${src}/${path}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const loadManifest = async (src) => JSON.parse((await getBytes(src, MANIFEST_PATH)).toString("utf8"));

async function verifyServed(src, m) {
  const bad = [];
  for (const [p, h] of Object.entries(m.files)) {
    // The SPA's HTML may be served for a path without a file; only files the manifest lists are fetched.
    const got = sha256(await getBytes(src, p));
    if (got !== h) bad.push(p);
  }
  return bad;
}

async function main() {
  const o = opts(process.argv);
  const A = o.get("--a");
  const B = o.get("--b");
  if (!A || !B) throw new Error("usage: two-hosts.mjs --a <url|dist> --b <url|dist>");
  const outDir = resolve(o.get("--out", "reports/two-hosts"));
  const histFile = resolve(o.get("--history", join(outDir, "history.json")));
  mkdirSync(outDir, { recursive: true });
  let a, b;
  try {
    [a, b] = await Promise.all([loadManifest(A), loadManifest(B)]);
  } catch (e) {
    console.error(`two-hosts: no manifest: ${e.message}`);
    process.exit(2);
  }
  const result = compareManifests(a, b);
  if (o.has("--verify-fetch") && result.comparable) {
    for (const [src, m, name] of [[A, a, "first"], [B, b, "second"]]) {
      const bad = await verifyServed(src, m);
      if (bad.length) {
        console.error(`two-hosts: the ${name} host serves ${bad.length} file(s) that differ from its own manifest, e.g. ${bad.slice(0, 5).join(", ")}`);
        process.exit(2);
      }
    }
  }
  const history = existsSync(histFile) ? JSON.parse(readFileSync(histFile, "utf8")) : [];
  const next = result.comparable ? withResult(history, { commit: result.commit, date: new Date().toISOString().slice(0, 10), identical: result.identical }) : history;
  if (result.comparable) writeFileSync(histFile, JSON.stringify(next, null, 1) + "\n");
  for (const l of reportLines(result, next)) console.log(l);
  if (!result.comparable) process.exit(2);
  const report = { ...result, hosts: [{ src: A, host: a.host, node: a.node }, { src: B, host: b.host, node: b.node }], streak: streak(next) };
  writeFileSync(join(outDir, `${result.commit}.json`), JSON.stringify(report, null, 1) + "\n");
  const st = attestation(result, a, b);
  if (st) writeFileSync(join(outDir, `${result.commit}.intoto.json`), JSON.stringify(st, null, 1) + "\n");
  if (o.has("--diffoscope") && result.differ.length) {
    const tmp = mkdtempSync(join(tmpdir(), "two-hosts-"));
    for (const p of result.differ.slice(0, 20)) {
      const fa = join(tmp, "a-" + p.replace(/\//g, "_"));
      const fb = join(tmp, "b-" + p.replace(/\//g, "_"));
      writeFileSync(fa, await getBytes(A, p));
      writeFileSync(fb, await getBytes(B, p));
      const r = spawnSync("diffoscope", ["--text", join(outDir, `${result.commit}.${p.replace(/\//g, "_")}.diffoscope.txt`), fa, fb], { encoding: "utf8" });
      if (r.error) {
        console.error("two-hosts: diffoscope is not installed (apt install diffoscope on the second host)");
        break;
      }
    }
  }
  process.exit(result.identical ? 0 : 1);
}

await main();
