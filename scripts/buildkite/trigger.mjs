#!/usr/bin/env node
/**
 * Start a Buildkite build for every new PR head (plan W7.21).
 *
 * Why not Buildkite's GitHub webhook: Buildkite skips a build when the commit
 * message or the PR title contains `[skip ci]` (buildkite.com/docs/pipelines/skipping),
 * and every commit and PR title in this repository carries it so that GitHub
 * Actions stays off. So the second host polls GitHub every few minutes (a
 * systemd timer from scripts/buildkite/agent-bootstrap.sh) and creates the
 * builds through Buildkite's REST API, with a message that has no skip marker.
 *
 *   node scripts/buildkite/trigger.mjs              one pass: new heads → builds
 *   node scripts/buildkite/trigger.mjs --dry-run    print what it would build
 *   node scripts/buildkite/trigger.mjs --backfill 20 also build the 20 most recently updated older PRs
 *
 * Environment:
 *   LUMEN_BUILDKITE_ORG          the organization slug (required)
 *   LUMEN_BUILDKITE_PIPELINE     the pipeline slug (default lumen-md)
 *   LUMEN_BUILDKITE_TOKEN_FILE   an API access token with read_builds + write_builds only
 *   LUMEN_FACTORY_TOKEN_FILE     GitHub fine-grained token (W6.5) for reading PRs (rate limit); optional
 *   LUMEN_FACTORY_HOME           where the state file lives (default ~/lumen-factory)
 *   LUMEN_BUILDKITE_MAX          builds per pass (default 4)
 *   LUMEN_GITHUB_API, LUMEN_BUILDKITE_API  API bases (the self-test points them at a local server)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { REPO, buildRequest, planTriggers } from "./lib.mjs";

const env = process.env;
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes("--dry-run");
const GH = env.LUMEN_GITHUB_API || "https://api.github.com";
const BK = env.LUMEN_BUILDKITE_API || "https://api.buildkite.com";
const ORG = env.LUMEN_BUILDKITE_ORG;
const PIPE = env.LUMEN_BUILDKITE_PIPELINE || "lumen-md";
const HOME = env.LUMEN_FACTORY_HOME || join(homedir(), "lumen-factory");
const STATE = join(HOME, "buildkite-trigger.json");
const log = (...a) => console.log("[trigger]", ...a);
const secret = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").trim() : "");

if (!ORG) {
  console.error("trigger: set LUMEN_BUILDKITE_ORG (the organization slug)");
  process.exit(2);
}
const bkToken = secret(env.LUMEN_BUILDKITE_TOKEN_FILE);
if (!bkToken && !DRY) {
  console.error("trigger: LUMEN_BUILDKITE_TOKEN_FILE has no token (read_builds + write_builds)");
  process.exit(2);
}
const ghToken = secret(env.LUMEN_FACTORY_TOKEN_FILE);

async function api(base, path, { method = "GET", token, body } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

let state = { since: null, built: {} };
try {
  state = { ...state, ...JSON.parse(readFileSync(STATE, "utf8")) };
} catch {
  // why: the first pass has no state; it starts the clock now so the ~270 older PRs are not all queued at once
}
const now = new Date().toISOString();
if (!state.since) state.since = now;

const prs = [];
for (let page = 1; page <= 5; page++) {
  const batch = await api(GH, `/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`, { token: ghToken });
  prs.push(...batch);
  if (batch.length < 100) break;
}
const { todo, skipped } = planTriggers(prs, { built: new Set(Object.keys(state.built)), since: state.since, max: Number(env.LUMEN_BUILDKITE_MAX) || 4, backfill: Number(opt("backfill")) || 0 });
log(`${prs.length} open PRs; ${todo.length} to build now; ${skipped.length} older than ${state.since} left alone`);

for (const pr of todo) {
  const req = buildRequest(pr);
  if (DRY) {
    log(`would build #${pr.number} ${req.commit.slice(0, 12)} (${req.branch}): ${req.message}`);
    continue;
  }
  // A build may already exist (a lost state file, a manual build): never queue the same commit twice.
  const existing = await api(BK, `/v2/organizations/${ORG}/pipelines/${PIPE}/builds?commit=${req.commit}&per_page=1`, { token: bkToken });
  if (existing?.length) {
    state.built[req.commit] = { pr: pr.number, build: existing[0].number, at: now };
    log(`#${pr.number} ${req.commit.slice(0, 12)} already has build ${existing[0].number}`);
    continue;
  }
  const b = await api(BK, `/v2/organizations/${ORG}/pipelines/${PIPE}/builds`, { method: "POST", token: bkToken, body: req });
  state.built[req.commit] = { pr: pr.number, build: b?.number ?? null, at: now };
  log(`#${pr.number} ${req.commit.slice(0, 12)} → build ${b?.number} ${b?.web_url ?? ""}`);
}
if (!DRY) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}
