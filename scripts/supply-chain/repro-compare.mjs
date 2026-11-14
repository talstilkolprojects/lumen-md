#!/usr/bin/env node
/**
 * Compare two builds of one commit, file by file (plan W7.23).
 *
 *   node scripts/supply-chain/repro-compare.mjs <A> <B> [options]
 *
 * A and B are each one of:
 *   - a dist manifest (file path, or an https URL — the Cloudflare Worker's
 *     <worker>/__build/manifest.json, see scripts/supply-chain/cf-build.sh);
 *   - a build directory (dist/), hashed here;
 *   - `origin:<https url>`: a deployed site (e.g. a Vercel deployment). Every
 *     path in the OTHER side's manifest is fetched from it and hashed, so the
 *     comparison needs nothing from that host but its public files.
 *
 * Options:
 *   --ledger <file.jsonl>   append the verdict (one line per run) and print the streak
 *                           of consecutive identical commits (acceptance: 10)
 *   --attest <file.json>    when identical: write the in-toto Statement for W7.22
 *   --diffoscope <dirA> <dirB>  print a diffoscope command per differing file
 *   --labels A,B            names in the report (default: the builders)
 *
 * Exit 0 when identical, 1 when any file differs, 2 on a usage or input error.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256 } from "./lib.mjs";
import { attestationStatement, compareManifests, diffoscopeCommands, formatComparison, ledgerEntry, manifestOf, MANIFEST_SCHEMA, streak } from "./repro-lib.mjs";

const argv = process.argv.slice(2);
const flag = (n, k = 1) => {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  const v = argv.slice(i + 1, i + 1 + k);
  argv.splice(i, 1 + k);
  return k === 1 ? v[0] : v;
};
const ledger = flag("--ledger");
const attest = flag("--attest");
const diffo = flag("--diffoscope", 2);
const labels = flag("--labels")?.split(",");
const [specA, specB] = argv;
if (!specA || !specB) {
  console.error("usage: repro-compare.mjs <manifest|dir|url|origin:url> <manifest|dir|url|origin:url> [--ledger f] [--attest f] [--diffoscope dirA dirB]");
  process.exit(2);
}

async function fetchBytes(url) {
  const r = await fetch(url, { redirect: "follow", headers: { "accept-encoding": "identity" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function load(spec) {
  if (spec.startsWith("origin:")) return { origin: spec.slice(7).replace(/\/+$/, "") };
  if (/^https?:\/\//.test(spec)) return JSON.parse((await fetchBytes(spec)).toString("utf8"));
  const p = resolve(spec);
  if (!existsSync(p)) throw new Error(`no such file or directory: ${spec}`);
  if (statSync(p).isDirectory()) return manifestOf(p, { builder: `dir:${spec}` });
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Hash, from a deployed origin, every path the other manifest lists. */
async function fromOrigin(origin, other) {
  const files = {};
  const paths = Object.keys(other.files);
  let i = 0;
  const worker = async () => {
    while (i < paths.length) {
      const p = paths[i++];
      try {
        const data = await fetchBytes(`${origin}/${p.split("/").map(encodeURIComponent).join("/")}`);
        files[p] = { sha256: sha256(data), size: data.length };
      } catch {
        // missing on the origin: reported as "only in" the other side
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { schema: MANIFEST_SCHEMA, builder: `origin:${origin}`, commit: other.commit, lockfileSha256: other.lockfileSha256, fileCount: Object.keys(files).length, files };
}

let a;
let b;
try {
  a = await load(specA);
  b = await load(specB);
  if (a.origin && b.origin) throw new Error("at most one side can be an origin: the other side's manifest names the files");
  if (a.origin) a = await fromOrigin(a.origin, b);
  if (b.origin) b = await fromOrigin(b.origin, a);
} catch (e) {
  console.error(`repro-compare: ${e.message}`);
  process.exit(2);
}
const [la, lb] = labels ?? [a.builder ?? "A", b.builder ?? "B"];
const r = compareManifests(a, b);
console.log(formatComparison(r, la, lb));
if (diffo && r.differs.length) {
  console.log("\n# the differences, byte by byte (on the second host):");
  for (const c of diffoscopeCommands(r, diffo[0], diffo[1])) console.log(c);
}
if (ledger) {
  mkdirSync(dirname(resolve(ledger)), { recursive: true });
  appendFileSync(ledger, JSON.stringify(ledgerEntry(r, a, b)) + "\n");
  const entries = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`ledger: ${ledger} — ${streak(entries)} consecutive identical commit(s) (target 10)`);
}
if (attest && r.identical) {
  writeFileSync(attest, JSON.stringify(attestationStatement(a, b, r), null, 1) + "\n");
  console.log(`attestation statement (for W7.22 to sign): ${attest}`);
}
process.exit(r.errors.length ? 2 : r.identical ? 0 : 1);
