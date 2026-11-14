#!/usr/bin/env node
/**
 * Launch gates as code (plan W11.L1).
 *
 *   npm run launch:gate -- M0            PASS/FAIL per criterion of M0; exit 1 unless all pass
 *   npm run launch:gate -- M0 --json     the same as JSON
 *   npm run launch:gate -- --check       only check docs/launch/milestones.json itself
 *   … --root <dir>                       another checkout (the tests use this)
 *
 * Reads docs/launch/milestones.json and the receipts in
 * docs/launch/receipts/<milestone>/<criterion>.json. Runs no tests and sends
 * nothing: a receipt is the record of a run made elsewhere (see
 * docs/launch/receipts/README.md). A criterion without a valid receipt fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluate, gateText, milestoneProblems } from "./lib/launchGate.mjs";

const args = process.argv.slice(2);
const rootAt = args.indexOf("--root");
const root = resolve(rootAt >= 0 ? args[rootAt + 1] : ".");
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");
const file = join(root, "docs/launch/milestones.json");

let data;
try {
  data = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`✖ ${file}: ${e.message}`);
  process.exit(2);
}
const shape = milestoneProblems(data);
if (shape.length) {
  for (const p of shape) console.error(`✖ ${p}`);
  process.exit(2);
}
if (args.includes("--check")) {
  console.log(`✓ milestones.json: ${data.milestones.length} milestones, ${data.milestones.reduce((n, m) => n + m.criteria.length, 0)} criteria, each mapped to a plan acceptance and a receipt`);
  process.exit(0);
}
if (ids.length !== 1) {
  console.error(`usage: npm run launch:gate -- <${data.milestones.map((m) => m.id).join("|")}> [--json] [--root <dir>]`);
  process.exit(2);
}

const commitExists = (sha) => {
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false; // not a git checkout, or the commit is not in it: the receipt cannot be tied to this code
  }
};
const readReceipt = (m, c) => {
  const p = join(root, "docs/launch/receipts", m, `${c}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const today = process.env.LAUNCH_GATE_TODAY ?? new Date().toISOString().slice(0, 10);
let r;
try {
  r = evaluate(data, ids[0], { readReceipt, commitExists, fileExists: (f) => existsSync(join(root, f)), today });
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exit(2);
}
process.stdout.write(args.includes("--json") ? JSON.stringify(r, null, 2) + "\n" : gateText(r));
process.exit(r.pass ? 0 : 1);
