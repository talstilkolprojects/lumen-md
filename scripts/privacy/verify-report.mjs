#!/usr/bin/env node
/**
 * Verify a signed privacy report from Lumen (plan W2.24).
 *
 *   node scripts/privacy/verify-report.mjs <report.json> [--pub <key.pub>] [--local-only] [--extract <dir>]
 *
 *   --pub        pin the device key (minisign public key file); without it the
 *                key in the report is used, which proves the file is unchanged
 *                since it was signed, not who signed it
 *   --local-only also require a local-only session in which nothing left the device
 *   --extract    write report.json, report.json.minisig and report.pub into <dir>,
 *                for `minisign -Vm report.json -p report.pub`
 *
 * Exit status 0 when every check passes, 1 otherwise (each problem is printed).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opts } from "../supply-chain/lib.mjs";
import { reportSha256, verifyBundle } from "./report-core.mjs";

export function verifyFile(file, { pub, localOnly = false } = {}) {
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  return { bundle, ...verifyBundle(bundle, { pub, localOnly }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = opts(process.argv);
  const file = o.args.find((a, i) => !a.startsWith("--") && !["--pub", "--extract"].includes(o.args[i - 1]));
  if (!file) {
    console.error("usage: node scripts/privacy/verify-report.mjs <report.json> [--pub <key.pub>] [--local-only] [--extract <dir>]");
    process.exit(2);
  }
  const pubFile = o.get("--pub");
  let r;
  try {
    r = verifyFile(file, { pub: pubFile ? readFileSync(pubFile, "utf8") : undefined, localOnly: o.has("--local-only") });
  } catch (e) {
    console.error(`✗ ${file}: ${e.message}`);
    process.exit(1);
  }
  const dir = o.get("--extract");
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), r.bundle.report);
    writeFileSync(join(dir, "report.json.minisig"), r.bundle.minisig);
    writeFileSync(join(dir, "report.pub"), r.bundle.publicKey);
  }
  if (!r.ok) {
    console.error(`✗ ${file}`);
    for (const p of r.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const s = r.report.summary;
  console.log(`✓ ${file}: signed by key ${r.keyId}${pubFile ? " (pinned)" : ""}, sha256 ${reportSha256(r.bundle)}`);
  console.log(`  ${r.report.app.name} ${r.report.app.version}, policy ${r.report.policy}${r.report.auditMode ? ", audit mode" : ""}, ${new Date(r.report.session.startedAt).toISOString()} – ${new Date(r.report.session.endedAt).toISOString()}`);
  console.log(`  ${s.requests} requests, ${s.leftDevice} left the device${s.nonLocalHosts.length ? ` (${s.nonLocalHosts.join(", ")})` : ""}, ${s.blocked} blocked, ${s.bytesOut} bytes out, ${s.bytesIn} bytes in`);
}
