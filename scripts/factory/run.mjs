#!/usr/bin/env node
/**
 * One night of the verification factory (plan W6.5). The scheduler that
 * scripts/factory/bootstrap.sh installs (a systemd timer on Ubuntu, a
 * LaunchAgent on a Mac) starts it; scripts/factory/lib.mjs says what it does.
 *
 *   node scripts/factory/run.mjs                 # tonight's run
 *   node scripts/factory/run.mjs --dry-run       # list the heads and what would run; run nothing
 *   node scripts/factory/run.mjs --only verify/train --rerun --max 1
 *   node scripts/factory/run.mjs --no-push --no-status   # keep everything on this machine
 *
 * Configuration (environment; bootstrap.sh writes it to the factory's env file):
 *   LUMEN_FACTORY_HOME     where repo/, receipts/, work/, cache/ and logs/ live (default ~/lumen-factory)
 *   LUMEN_FACTORY_EXEC     docker (Ubuntu host) | native (a Mac: WebKit on macOS itself)
 *   LUMEN_FACTORY_HOST     a label for the receipts, e.g. oracle-a1 or mac (never the host name)
 *   LUMEN_FACTORY_JOBS     parallel steps in a parallel group (default: CPUs / 2, at least 1)
 *   LUMEN_FACTORY_MAX_HEADS full runs per night (default 3); the rest get a heartbeat or wait
 *   LUMEN_FACTORY_REMOTE   the repository to clone (default https://github.com/talstilkol/lumen-md.git)
 *   LUMEN_FACTORY_TOKEN_FILE  a file with the fine-grained token (Commit statuses: write) for gh
 *   LUMEN_NIGHTLY_KEY      the Ed25519 key that seals the receipts (scripts/nightly/receipt.mjs)
 *   DOCKER                 docker or podman
 *
 * Exit 0 when every head that ran passed, 1 when any suite failed, 2 on a setup error.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, keyPath, loadOrCreateKey, seal, sha256 } from "../nightly/receipt.mjs";
import {
  BRANCH_GLOB,
  RECEIPTS_REPO,
  REPO,
  extraSteps,
  genericSteps,
  groupSteps,
  hostSteps,
  morningReport,
  nightName,
  parseLsRemote,
  planNight,
  receiptPath,
  statusesFor,
  suiteVerdicts,
  summarizePlaywright,
  summarizeVitest,
} from "./lib.mjs";

const TOOL = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const env = process.env;
const HOME = resolve(env.LUMEN_FACTORY_HOME || join(homedir(), "lumen-factory"));
const EXEC = env.LUMEN_FACTORY_EXEC || (process.platform === "darwin" ? "native" : "docker");
const HOST = env.LUMEN_FACTORY_HOST || (process.platform === "darwin" ? "mac" : "linux");
const JOBS = Math.max(1, Number(env.LUMEN_FACTORY_JOBS) || Math.floor(availableParallelism() / 2));
const REMOTE = env.LUMEN_FACTORY_REMOTE || `https://github.com/${REPO}.git`;
const DOCKER = env.DOCKER || "docker";
const dirs = { repo: join(HOME, "repo"), receipts: join(HOME, "receipts"), work: join(HOME, "work"), cache: join(HOME, "cache"), logs: join(HOME, "logs") };

const log = (...a) => console.log("[factory]", ...a);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20, ...opts });
  if (opts.check !== false && r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → exit ${r.status ?? r.signal}: ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 400)}`);
  return (r.stdout ?? "").trim();
}
const git = (cwd, ...args) => sh("git", ["-C", cwd, ...args]);

function ghEnv() {
  const f = env.LUMEN_FACTORY_TOKEN_FILE;
  if (f && existsSync(f)) return { ...env, GH_TOKEN: readFileSync(f, "utf8").trim() };
  return env;
}
const gh = (args, opts = {}) => sh("gh", args, { env: ghEnv(), ...opts });

/** Start a step; resolves to its result line for the report. */
function runStep(exec, step, logDir) {
  return new Promise((done) => {
    const t0 = Date.now();
    const [cmd, args, opts] = exec.argv(step);
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => chunks.push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      exec.interrupt?.(step);
    }, step.timeoutMin * 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString("utf8");
      writeFileSync(join(logDir, `${step.id}.log`), out);
      const status = timedOut ? "timeout" : code ?? String(signal);
      log(`${status === 0 ? "✓" : "✗"} ${step.id} (${Math.round((Date.now() - t0) / 1000)} s)`);
      done({
        id: step.id,
        group: step.group,
        cmd: step.cmd.join(" "),
        status,
        ms: Date.now() - t0,
        output: { sha256: sha256(out), bytes: Buffer.byteLength(out), tail: out.replace(/\u001b\[[0-9;]*m/g, "").trim().split("\n").slice(-12) },
      });
    });
  });
}

/** Run the groups in order; the parallel steps of a group `jobs` at a time. */
async function runGroups(exec, steps, logDir) {
  const results = [];
  for (const [, group] of groupSteps(steps)) {
    const width = group.every((s) => s.parallel) ? JOBS : 1;
    const active = new Set();
    for (const step of group) {
      const p = runStep(exec, step, logDir).then((r) => {
        results.push(r);
        active.delete(p);
      });
      active.add(p);
      if (active.size >= width) await Promise.race(active);
    }
    await Promise.all(active);
  }
  const order = steps.map((s) => s.id);
  return results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** How steps run: inside the Playwright image (docker), or on the machine itself (native, a Mac). */
function executor(kind, wt, sha) {
  if (kind === "native") {
    return {
      label: "native",
      argv: (s) => [s.cmd[0], s.cmd.slice(1), { cwd: wt, env: { ...env, CI: "1", ...(s.env ?? {}) } }],
      start() {},
      stop() {},
    };
  }
  const lock = JSON.parse(readFileSync(join(wt, "package-lock.json"), "utf8"));
  const pw = lock.packages?.["node_modules/@playwright/test"]?.version;
  if (!pw) throw new Error("package-lock.json has no @playwright/test: cannot pick the Playwright image");
  const tag = `lumen-factory:pw-${pw}`;
  const name = `lumen-factory-${sha.slice(0, 12)}`;
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
  return {
    label: `docker ${tag}`,
    image: tag,
    start() {
      if (spawnSync(DOCKER, ["image", "inspect", tag], { stdio: "ignore" }).status !== 0) {
        log(`building ${tag}`);
        sh(DOCKER, ["build", "-f", join(TOOL, "scripts/factory/Dockerfile.factory"), "--build-arg", `PW_VERSION=${pw}`, "-t", tag, join(TOOL, "scripts/factory")], { stdio: "inherit" });
      }
      spawnSync(DOCKER, ["rm", "-f", name], { stdio: "ignore" });
      sh(DOCKER, [
        "run", "-d", "--name", name, "--init", "--ipc=host", "-u", uid,
        "-e", "HOME=/tmp/home", "-e", "CI=1", "-e", "npm_config_cache=/cache/npm", "-e", "CARGO_HOME=/cache/cargo",
        // The worktree's .git file points into repo/.git by absolute path: mount it at that path so git works inside.
        "-v", `${wt}:/lumen`, "-v", `${dirs.repo}:${dirs.repo}`, "-v", `${dirs.cache}:/cache`, "-w", "/lumen", tag, "sleep", "infinity",
      ]);
    },
    argv: (s) => [DOCKER, ["exec", ...Object.entries(s.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "-w", "/lumen", name, ...s.cmd], {}],
    interrupt: () => spawnSync(DOCKER, ["exec", name, "pkill", "-TERM", "-f", "playwright|vitest|vite"], { stdio: "ignore" }),
    stop: () => spawnSync(DOCKER, ["rm", "-f", name], { stdio: "ignore" }),
  };
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null; // why: the step did not get far enough to write it
  }
};

/** The commit's own step plan (scripts/nightly/plan.mjs, W6.8) when it has one, else the generic one. */
async function stepPlan(exec, wt, logDir) {
  if (existsSync(join(wt, "scripts/nightly/plan.mjs"))) {
    const probe = { id: "plan", group: "setup", timeoutMin: 2, cmd: ["node", "--input-type=module", "-e", "const m=await import('./scripts/nightly/plan.mjs');process.stdout.write(JSON.stringify(m.fullSteps()))"] };
    const r = await runStep(exec, probe, logDir);
    const text = readFileSync(join(logDir, "plan.log"), "utf8");
    if (r.status === 0) {
      try {
        return { source: "scripts/nightly/plan.mjs", steps: hostSteps(JSON.parse(text.slice(text.indexOf("[")))) };
      } catch {
        log("plan.mjs printed no step list: using the generic plan");
      }
    }
  }
  return { source: "generic (scripts/factory/lib.mjs)", steps: genericSteps() };
}

/** The PR that last changed each failing file (best effort: an unknown file is left out). */
function lastPrs(wt, files) {
  const out = {};
  for (const file of files.slice(0, 40)) {
    try {
      const sha = git(wt, "log", "-1", "--format=%H", "--", file);
      if (!sha) continue;
      const n = gh(["api", `repos/${REPO}/commits/${sha}/pulls`, "--jq", ".[0].number // empty"], { check: false });
      if (/^\d+$/.test(n)) out[file] = Number(n);
    } catch {
      /* why: attribution is a hint in the morning report, never a reason to fail the night */
    }
  }
  return out;
}

async function fullRun(head, { privateKeyPem, startedNight, opts }) {
  const startedAt = new Date().toISOString();
  const wt = join(dirs.work, head.sha.slice(0, 12));
  const logDir = join(dirs.logs, `${startedNight.slice(0, 10)}-${head.sha.slice(0, 12)}`);
  mkdirSync(logDir, { recursive: true });
  if (existsSync(wt)) spawnSync("git", ["-C", dirs.repo, "worktree", "remove", "--force", wt], { stdio: "ignore" });
  git(dirs.repo, "worktree", "add", "--detach", "-f", wt, head.sha);
  const exec = executor(EXEC, wt, head.sha);
  const steps = [];
  let plan = { source: "none", steps: [] };
  try {
    exec.start();
    const install = await runStep(exec, { id: "install", group: "setup", cmd: ["npm", "ci", "--no-audit", "--no-fund"], timeoutMin: 20 }, logDir);
    steps.push(install);
    if (EXEC === "native" && install.status === 0) steps.push(await runStep(exec, { id: "browsers", group: "setup", cmd: ["npx", "playwright", "install"], timeoutMin: 20 }, logDir));
    if (install.status === 0) {
      plan = await stepPlan(exec, wt, logDir);
      const pkg = readJson(join(wt, "package.json")) ?? {};
      const all = [...plan.steps, ...extraSteps({ scripts: pkg.scripts ?? {}, hasCargo: existsSync(join(wt, "src-tauri/Cargo.toml")), date: new Date(startedNight) })];
      steps.push(...(await runGroups(exec, all, logDir)));
    }
  } finally {
    exec.stop();
  }
  const nightly = join(wt, "reports/nightly");
  const vitest = steps.filter((s) => s.id.startsWith("vitest-")).map((s) => summarizeVitest(readJson(join(nightly, `${s.id}.json`)), EXEC === "native" ? `${wt}/` : "/lumen/"));
  const e2e = Object.fromEntries(steps.filter((s) => s.id.startsWith("e2e-")).map((s) => [s.id, summarizePlaywright(readJson(join(nightly, `${s.id}.json`)))]));
  const { suites, mustRun } = suiteVerdicts(steps, { vitest, e2e });
  if (steps[0]?.status !== 0) suites.install = { ok: false, detail: `npm ci: exit ${steps[0]?.status}` };
  const failures = { vitest: vitest.filter(Boolean).flatMap((v) => v.failedFiles) };
  for (const b of ["chromium", "firefox", "webkit"]) failures[`e2e ${b}`] = Object.entries(e2e).filter(([id, x]) => x && id.startsWith(`e2e-${b}-`)).flatMap(([, x]) => x.failed);
  const prs = lastPrs(wt, [...new Set(Object.values(failures).flat().map((x) => x.split(" › ")[0]))]);
  const finishedAt = new Date().toISOString();
  const report = {
    version: 1,
    kind: "full",
    trigger: opts.scheduled ? "schedule" : "manual",
    startedAt,
    finishedAt,
    minutes: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 6000) / 10,
    commit: { sha: head.sha, branch: head.branch, dirty: false },
    machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: availableParallelism(), host: HOST, exec: exec.label },
    plan: plan.source,
    steps,
    suites,
    mustRun,
    failures,
    prs,
  };
  spawnSync("git", ["-C", dirs.repo, "worktree", "remove", "--force", wt], { stdio: "ignore" });
  const path = receiptPath(head.sha, "full", startedAt);
  const file = join(dirs.receipts, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(seal(report, privateKeyPem), null, 2) + "\n");
  log(`receipt ${path}`);
  if (!opts.noStatus) postStatuses(report, `https://github.com/${RECEIPTS_REPO}/blob/main/${path}`);
  return { report, path };
}

function postStatuses(report, url) {
  for (const s of statusesFor(report, url)) {
    const r = spawnSync("gh", ["api", "-X", "POST", `repos/${REPO}/statuses/${report.commit.sha}`, "-f", `state=${s.state}`, "-f", `context=${s.context}`, "-f", `description=${s.description}`, "-f", `target_url=${s.target_url}`], { env: ghEnv(), encoding: "utf8" });
    if (r.status !== 0) log(`✗ status ${s.context}: ${(r.stderr || "").trim().slice(0, 200)}`);
  }
}

/** Every sealed full receipt in the receipts clone, by commit. */
function fullReceipts() {
  const root = join(dirs.receipts, "commits");
  const out = new Map();
  if (!existsSync(root)) return out;
  for (const sha of readdirSync(root)) {
    const files = readdirSync(join(root, sha)).filter((f) => f.startsWith("full-") && f.endsWith(".json")).sort();
    if (files.length) out.set(sha, `commits/${sha}/${files[files.length - 1]}`);
  }
  return out;
}

/** The latest full report of each branch before tonight (for "what changed since"). */
function previousByBranch(receipts) {
  const out = {};
  for (const path of receipts.values()) {
    const r = readJson(join(dirs.receipts, path));
    if (!r?.commit?.branch) continue;
    if (!out[r.commit.branch] || out[r.commit.branch].startedAt < r.startedAt) out[r.commit.branch] = r;
  }
  return out;
}

function ensureClones(opts) {
  mkdirSync(HOME, { recursive: true });
  for (const d of Object.values(dirs)) if (d !== dirs.repo && d !== dirs.receipts) mkdirSync(d, { recursive: true });
  if (!existsSync(join(dirs.repo, ".git"))) sh("git", ["clone", "-q", "--no-checkout", REMOTE, dirs.repo]);
  git(dirs.repo, "fetch", "-q", "--prune", "origin", `+refs/heads/${BRANCH_GLOB}:refs/remotes/origin/${BRANCH_GLOB}`);
  if (!existsSync(join(dirs.receipts, ".git"))) throw new Error(`${dirs.receipts} is not a clone of the receipts repository: run scripts/factory/bootstrap.sh`);
  if (!opts.noPush) git(dirs.receipts, "pull", "-q", "--ff-only");
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const opts = {
    dryRun: argv.includes("--dry-run"),
    // Once a week (Sunday UTC by default; LUMEN_FACTORY_RERUN_DAY=none turns it off) unchanged heads run again, to catch flakes.
    rerun: argv.includes("--rerun") || String(new Date().getUTCDay()) === (env.LUMEN_FACTORY_RERUN_DAY ?? "0"),
    noPush: argv.includes("--no-push"),
    noStatus: argv.includes("--no-status"),
    scheduled: argv.includes("--scheduled"),
    only: opt("only")?.split(",").filter(Boolean) ?? null,
    max: Number(opt("max") ?? env.LUMEN_FACTORY_MAX_HEADS ?? 3),
  };
  const heads = parseLsRemote(sh("git", ["ls-remote", REMOTE, `refs/heads/${BRANCH_GLOB}`]));
  if (opts.dryRun) {
    const done = existsSync(join(dirs.receipts, "commits")) ? new Set(fullReceipts().keys()) : new Set();
    const night = planNight(heads, { done, max: opts.max, rerun: opts.rerun, only: opts.only });
    log(`home ${HOME} · exec ${EXEC} · host ${HOST} · jobs ${JOBS} · key ${keyPath()}`);
    log(`full runs: ${night.run.map((h) => `${h.branch}@${h.sha.slice(0, 9)}`).join(", ") || "none"}`);
    log(`heartbeats: ${night.heartbeat.map((h) => h.branch).join(", ") || "none"} · later: ${night.later.map((h) => h.branch).join(", ") || "none"}`);
    for (const s of [...genericSteps(), ...extraSteps({ scripts: { "drill:data-safety": 1 }, hasCargo: true })]) log(`  ${s.group.padEnd(6)} ${s.parallel ? "∥" : " "} ${s.cmd.join(" ")}`);
    log("(the steps of a commit with scripts/nightly/plan.mjs come from that file)");
    return 0;
  }
  ensureClones(opts);
  const { privateKeyPem, publicKeyPem } = loadOrCreateKey();
  // One public key per host (keys/<host>.pem): the VM and the Mac fallback can both sign, each with its own key.
  const pubFile = join(dirs.receipts, "keys", `${HOST}.pem`);
  mkdirSync(dirname(pubFile), { recursive: true });
  if (!existsSync(pubFile)) writeFileSync(pubFile, publicKeyPem);
  else if (readFileSync(pubFile, "utf8") !== publicKeyPem) {
    console.error(`✗ ${pubFile} is not the public half of ${keyPath()}: another machine signs as "${HOST}". Set LUMEN_FACTORY_HOST to a new label.`);
    return 2;
  }
  const startedNight = new Date().toISOString();
  const receipts = fullReceipts();
  const previous = previousByBranch(receipts);
  const night = planNight(heads, { done: new Set(receipts.keys()), max: opts.max, rerun: opts.rerun, only: opts.only });
  log(`${heads.length} heads: ${night.run.length} to run, ${night.heartbeat.length} unchanged, ${night.later.length} later`);
  const ran = [];
  for (const head of night.run) {
    log(`▶ ${head.branch} @ ${head.sha.slice(0, 9)}`);
    try {
      const { report, path } = await fullRun(head, { privateKeyPem, startedNight, opts });
      ran.push({ ...report, path });
    } catch (e) {
      log(`✗ ${head.branch}: ${e instanceof Error ? e.message : e}`);
      ran.push({ commit: { sha: head.sha, branch: head.branch }, minutes: 0, suites: { setup: { ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 200) } }, failures: {}, path: null });
    }
  }
  const heartbeat = night.heartbeat.map((h) => ({ ...h, receipt: receipts.get(h.sha) }));
  // Heartbeats only point at a receipt of the same commit, after checking that it still verifies.
  for (const h of heartbeat) if (h.receipt && !check(readJson(join(dirs.receipts, h.receipt)), publicKeyPem).ok) h.receipt = `${h.receipt} (✗ does not verify)`;
  const date = startedNight.slice(0, 10);
  const nightReport = seal(
    {
      version: 1,
      kind: "night",
      trigger: opts.scheduled ? "schedule" : "manual",
      startedAt: startedNight,
      finishedAt: new Date().toISOString(),
      machine: { platform: process.platform, arch: process.arch, host: HOST },
      heads: [
        ...ran.map((r) => ({ branch: r.commit.branch, sha: r.commit.sha, ran: true, receipt: r.path, ok: Object.values(r.suites).every((s) => s.ok) })),
        ...heartbeat.map((h) => ({ branch: h.branch, sha: h.sha, ran: false, receipt: h.receipt })),
        ...night.later.map((h) => ({ branch: h.branch, sha: h.sha, ran: false, receipt: null, later: true })),
      ],
    },
    privateKeyPem,
  );
  mkdirSync(join(dirs.receipts, "nights"), { recursive: true });
  const names = nightName(date, (p) => existsSync(join(dirs.receipts, p)));
  writeFileSync(join(dirs.receipts, names.json), JSON.stringify(nightReport, null, 2) + "\n");
  const md = morningReport({ date, ran, heartbeat, later: night.later, prs: Object.assign({}, ...ran.map((r) => r.prs ?? {})), previous });
  writeFileSync(join(dirs.receipts, names.md), md + "\n");
  console.log(`\n${md}`);
  git(dirs.receipts, "add", "-A");
  if (spawnSync("git", ["-C", dirs.receipts, "diff", "--cached", "--quiet"]).status !== 0) {
    git(dirs.receipts, "-c", "user.name=lumen-factory", "-c", "user.email=factory@example.com", "commit", "-q", "-m", `night ${date}: ${ran.length} run, ${heartbeat.length} unchanged (${HOST})`);
    if (!opts.noPush) git(dirs.receipts, "push", "-q", "origin", "HEAD");
  }
  return ran.every((r) => Object.values(r.suites).every((s) => s.ok)) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`✗ factory: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    },
  );
