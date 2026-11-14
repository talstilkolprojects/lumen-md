#!/usr/bin/env node
/**
 * Fails when the built app (default: dist/) contains a collab server
 * secret or server code (plan 3.6.2). CI builds with canary values in the
 * secret env vars, then runs this, so "0 secrets in the bundle" is checked
 * against values that were really present at build time.
 *
 *   node scripts/check-bundle-secrets.mjs [dir]
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { scanForSecrets } from "./lib/bundleSecrets.mjs";

const dir = resolve(process.argv[2] ?? "dist");
if (!existsSync(dir)) {
  console.error(`${dir} does not exist: build first.`);
  process.exit(2);
}
const { findings, checkedValues } = scanForSecrets(dir);
console.log(`Checked ${dir} for ${checkedValues.length ? checkedValues.join(", ") : "no secret values (none set)"} and server code markers.`);
if (findings.length) {
  for (const f of findings) console.error(`::error file=${f.file}::${f.what} found in the bundle`);
  process.exit(1);
}
console.log("✓ 0 collab secrets in the bundle.");
