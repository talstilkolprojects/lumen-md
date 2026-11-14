#!/usr/bin/env node
/**
 * npm run promote:check -- [<commit>] (plan W6.6): refuse a promotion of main
 * unless that commit has a WebKit receipt and a Safari receipt, signed by a
 * trusted host (scripts/promote/lib.mjs says what counts).
 *
 *   npm run promote:check                      # HEAD
 *   npm run promote:check -- origin/verify/train
 *   npm run promote:check -- <sha> --receipts ~/lumen-factory/receipts --pin b90d1811bd7b23b7
 *
 *   --receipts <dir>  a clone of talstilkol/lumen-md-receipts (default: .cache/lumen-receipts,
 *                     cloned or pulled from GitHub)
 *   --pin <fp,…>      trust only these key fingerprints (sha256 of the PEM, first 16 hex);
 *                     also LUMEN_RECEIPT_KEYS. Without it every keys/<host>.pem of the receipts
 *                     repository is trusted, and the check says so.
 *   --json            print the verdict as JSON
 *
 * Exit 0: may promote. 1: refused. 2: could not check (no git object, no receipts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, sha256 } from "../nightly/receipt.mjs";
import { promotionVerdict, verdictLines } from "./lib.mjs";

const RECEIPTS_URL = "https://github.com/talstilkol/lumen-md-receipts.git";

const git = (...args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** The trusted keys: fingerprint → PEM. */
export function loadKeys(dir, pins) {
  const keys = new Map();
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".pem"))) {
    const pem = readFileSync(join(dir, f), "utf8");
    const fp = sha256(pem).slice(0, 16);
    if (!pins || pins.includes(fp)) keys.set(fp, pem);
  }
  return keys;
}

/** Every receipt under commits/ of the candidate, or of a commit with the same tree, checked. */
export function loadReceipts(root, candidate, keys, treeOf) {
  const out = [];
  const base = join(root, "commits");
  if (!existsSync(base)) return out;
  const want = treeOf(candidate);
  for (const sha of readdirSync(base)) {
    if (sha !== candidate && (!want || treeOf(sha) !== want)) continue;
    for (const f of readdirSync(join(base, sha)).filter((x) => x.endsWith(".json"))) {
      const path = `commits/${sha}/${f}`;
      let report;
      try {
        report = JSON.parse(readFileSync(join(base, sha, f), "utf8"));
      } catch {
        out.push({ path, report: { commit: { sha } }, verified: { ok: false, problems: ["not JSON"] } });
        continue;
      }
      const pem = keys.get(report?.receipt?.key);
      const verified = pem ? check(report, pem) : { ok: false, problems: [`signed by key ${report?.receipt?.key ?? "?"}, which is not trusted`] };
      if (verified.ok && report.commit?.sha !== sha) {
        verified.ok = false;
        verified.problems = [`filed under ${sha.slice(0, 9)} but signed for ${String(report.commit?.sha).slice(0, 9)}`];
      }
      out.push({ path, report, verified });
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valued = new Set(["--receipts", "--pin"]);
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
  const rev = positional[0] ?? "HEAD";
  const candidate = git("rev-parse", "--verify", `${rev}^{commit}`);
  if (!candidate) {
    console.error(`✗ promote:check: ${rev} is not a commit here (fetch it first)`);
    process.exit(2);
  }
  let root = opt("receipts") ?? process.env.LUMEN_RECEIPTS_DIR;
  if (!root) {
    root = resolve(".cache/lumen-receipts");
    const ok = existsSync(join(root, ".git")) ? git("-C", root, "pull", "-q", "--ff-only") !== null : git("clone", "-q", "--depth=1", RECEIPTS_URL, root) !== null;
    if (!ok) {
      console.error(`✗ promote:check: could not clone or update ${RECEIPTS_URL} into ${root}`);
      process.exit(2);
    }
  }
  const pins = (opt("pin") ?? process.env.LUMEN_RECEIPT_KEYS)?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const keys = loadKeys(join(root, "keys"), pins);
  if (!keys.size) {
    console.error(`✗ promote:check: no trusted key in ${join(root, "keys")}${pins ? ` matching ${pins.join(", ")}` : ""}`);
    process.exit(2);
  }
  const treeOf = (sha) => git("rev-parse", "--verify", "-q", `${sha}^{tree}`);
  const receipts = loadReceipts(root, candidate, keys, treeOf);
  const verdict = promotionVerdict(candidate, receipts, (a, b) => {
    const ta = treeOf(a);
    return ta !== null && ta === treeOf(b);
  });
  if (argv.includes("--json")) console.log(JSON.stringify({ candidate, trusted: [...keys.keys()], pinned: Boolean(pins), ...verdict }, null, 2));
  else {
    if (!pins) console.log(`(trusting every key in ${join(root, "keys")}: ${[...keys.keys()].join(", ")}; pin them with --pin or LUMEN_RECEIPT_KEYS)`);
    for (const line of verdictLines(candidate, verdict)) console.log(line);
  }
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
