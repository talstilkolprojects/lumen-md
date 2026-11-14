#!/usr/bin/env node
/**
 * The last job of a Buildkite build (plan W7.21): a signed receipt of what
 * every gate did, in the format of the nightly receipts (W4.36, #455) and
 * the factory's `full` receipts (W6.5), so W6.7's plan:receipts (#511)
 * counts a Buildkite run like a factory night.
 *
 *   node scripts/buildkite/receipt.mjs --gates static,lint,build,…   (in the build; reads BUILDKITE_* and asks the agent)
 *   node scripts/buildkite/receipt.mjs --verify <receipt.json> [--key keys/<host>.pem]
 *
 * In the build it:
 *   1. asks `buildkite-agent step get outcome --step <key>` for every gate
 *   2. reads ci-out/vitest-summary.json (the merge step's artifact)
 *   3. seals the report with the host's Ed25519 key (LUMEN_NIGHTLY_KEY, the factory's key)
 *   4. writes ci-out/receipt.json (a build artifact), annotates the build with its sha256,
 *      and, when the factory's receipts clone exists, commits it as
 *      commits/<sha>/full-<time>.json and pushes (the factory's deploy key)
 *   5. with the factory's token (LUMEN_FACTORY_TOKEN_FILE): a `lumen/receipt` commit status
 *      whose description is the receipt's sha256 and whose link is the receipt
 * It exits 0 when the receipt is written: the gates' own statuses carry pass and fail.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, keyPath, loadOrCreateKey, seal } from "../nightly/receipt.mjs";
import { RECEIPTS_REPO, receiptPath } from "../factory/lib.mjs";
import { REPO, receiptReport } from "./lib.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const env = process.env;
const log = (...a) => console.log("[receipt]", ...a);
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null; // why: the merge step failed before writing its summary
  }
};

if (opt("verify")) {
  const report = readJson(opt("verify"));
  const pem = opt("key") ? readFileSync(opt("key"), "utf8") : null;
  const r = check(report, pem);
  console.log(r.ok ? `✓ ${opt("verify")}: sha256 ${report.receipt.sha256}${pem ? ", signature verified" : " (digest only: pass --key for the signature)"}` : `✗ ${r.problems.join("; ")}`);
  process.exit(r.ok ? 0 : 1);
}

const gates = (opt("gates") ?? "").split(",").filter(Boolean);
if (!gates.length) {
  console.error("receipt: --gates <key,…> is required");
  process.exit(2);
}
const agent = env.BUILDKITE_AGENT_BIN || "buildkite-agent";
const outcomes = {};
for (const key of gates) {
  const r = spawnSync(agent, ["step", "get", "outcome", "--step", key], { encoding: "utf8" });
  // An unknown or unreadable outcome is recorded as such and never counted as a pass.
  outcomes[key] = r.status === 0 ? r.stdout.trim() || "unknown" : "unknown";
}
const sha = env.BUILDKITE_COMMIT ?? "";
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`receipt: BUILDKITE_COMMIT is not a commit sha (${sha || "unset"})`);
  process.exit(2);
}
const vitest = readJson(join(root, "ci-out/vitest-summary.json"));
// Set by the vitest-plan job, the first one the build schedules: wall time from there to here.
const meta = spawnSync(agent, ["meta-data", "get", "lumen:started-at", "--default", ""], { encoding: "utf8" });
const startedAt = meta.status === 0 && /^\d{4}-\d\d-\d\dT/.test(meta.stdout.trim()) ? meta.stdout.trim() : null;
const finishedAt = new Date().toISOString();
const report = receiptReport({
  commit: { sha, branch: env.BUILDKITE_BRANCH ?? null, pr: /^\d+$/.test(env.BUILDKITE_PULL_REQUEST ?? "") ? Number(env.BUILDKITE_PULL_REQUEST) : env.LUMEN_CI_PR ? Number(env.LUMEN_CI_PR) : null, dirty: false },
  build: { system: "buildkite", number: Number(env.BUILDKITE_BUILD_NUMBER) || null, url: env.BUILDKITE_BUILD_URL ?? null, pipeline: env.BUILDKITE_PIPELINE_SLUG ?? null },
  outcomes,
  vitest,
  machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: availableParallelism(), host: env.LUMEN_FACTORY_HOST || "buildkite-linux", exec: "buildkite" },
  startedAt,
  finishedAt,
});
const { privateKeyPem } = loadOrCreateKey(keyPath(env));
const sealed = seal(report, privateKeyPem);
const out = join(root, "ci-out/receipt.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(sealed, null, 2) + "\n");
const bad = Object.entries(report.suites).filter(([, s]) => !s.ok).map(([k]) => k);
log(`sealed ${Object.keys(report.suites).length} suites (${bad.length ? `failed: ${bad.join(", ")}` : "all passed"}), sha256 ${sealed.receipt.sha256}, key ${sealed.receipt.key}`);

// The receipts repository (W6.5): only on the factory host, which has the clone and the deploy key.
let link = env.BUILDKITE_BUILD_URL ? `${env.BUILDKITE_BUILD_URL}#receipt` : null;
const receipts = env.LUMEN_FACTORY_HOME ? join(env.LUMEN_FACTORY_HOME, "receipts") : null;
if (receipts && existsSync(join(receipts, ".git")) && !argv.includes("--no-push")) {
  const path = receiptPath(sha, "full", finishedAt);
  const file = join(receipts, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sealed, null, 2) + "\n");
  const g = (...a) => spawnSync("git", ["-C", receipts, ...a], { encoding: "utf8", env: { ...env, GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? (env.LUMEN_FACTORY_HOME ? `ssh -F ${join(env.LUMEN_FACTORY_HOME, ".ssh/config")}` : undefined) } });
  g("add", path);
  g("-c", "user.name=lumen-factory", "-c", "user.email=noreply@example.com", "commit", "-q", "-m", `buildkite ${env.BUILDKITE_BUILD_NUMBER ?? "?"}: ${sha.slice(0, 12)} ${bad.length ? `✗ ${bad.join(", ")}` : "✓"}`);
  let pushed = false;
  for (let i = 0; i < 3 && !pushed; i++) {
    pushed = g("push", "-q").status === 0;
    if (!pushed) g("pull", "-q", "--rebase");
  }
  if (pushed) link = `https://github.com/${RECEIPTS_REPO}/blob/main/${path}`;
  log(pushed ? `pushed ${path}` : `✗ could not push ${path}; it stays in ${receipts}`);
}

const annotation = [`**Signed receipt** for \`${sha.slice(0, 12)}\`: sha256 \`${sealed.receipt.sha256}\`, Ed25519 key \`${sealed.receipt.key}\``, link ? `([receipt](${link}))` : "", "", "| suite | | detail |", "|---|---|---|", ...Object.entries(report.suites).map(([k, s]) => `| ${k} | ${s.ok ? "✓" : "✗"} | ${String(s.detail).replace(/\|/g, "\\|")} |`)].join("\n");
spawnSync(agent, ["annotate", "--style", bad.length ? "error" : "success", "--context", "lumen-receipt"], { input: annotation, encoding: "utf8" });

// One status with the receipt's hash and link (the factory's fine-grained token: Commit statuses only).
const tokenFile = env.LUMEN_FACTORY_TOKEN_FILE;
if (tokenFile && existsSync(tokenFile) && link && !argv.includes("--no-status")) {
  const token = readFileSync(tokenFile, "utf8").trim();
  const r = spawnSync("gh", ["api", "-X", "POST", `repos/${REPO}/statuses/${sha}`, "-f", `state=${bad.length ? "failure" : "success"}`, "-f", "context=lumen/receipt", "-f", `description=sha256 ${sealed.receipt.sha256.slice(0, 16)}… ${bad.length ? `${bad.length} failed` : "all passed"}`, "-f", `target_url=${link}`], { encoding: "utf8", env: { ...env, GH_TOKEN: token } });
  log(r.status === 0 ? "status lumen/receipt posted" : `✗ status: ${(r.stderr || "").trim().slice(0, 200)}`);
}
