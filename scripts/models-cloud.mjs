#!/usr/bin/env node
/**
 * The real models day without Tal (plan W6.18): one command runs
 * `npm run models:day` on a free Kaggle GPU, with the held-out sets, and
 * brings back the sealed report.
 *
 *   npm run models:cloud -- setup             the one owner step, and whether this machine is ready
 *   npm run models:cloud [-- run] [--ref R] [--only a,b] [--skip a,b] [--no-heldout] [--no-wait] [--push]
 *   npm run models:cloud -- fetch <run>       download, verify and unpack a finished run into eval/results/day/<run>
 *                                             (--results DIR elsewhere; --push: commit it to the branch eval/day-<run>)
 *   npm run models:cloud -- status <run>
 *   npm run models:cloud -- mac [models:day options]   the backup: the same day on Tal's Mac, WebGPU steps included
 *   npm run models:cloud -- dictation [--ref R] [--no-push]
 *                                             plan W6.19 in one command: only the Hebrew dictation steps (phone, browser,
 *                                             desktop, and the held-out asr-he), wait, verify, and push eval/day-<run>
 *                                             with src/ai/dictation/measuredWer.json filled from the measurement
 *
 * The run's secrets (a one-run signing key, a one-run key for the held-out
 * copy) go into a private Kaggle dataset that only the account owner can
 * read; the evaluator's own key never leaves this machine. The runner keeps
 * the public half of the signing key in ~/.cache/lumen-cloud/<run>/ and
 * accepts only a report signed by it, for the commit it asked for.
 *
 * Needs: the Kaggle CLI (`pip install kaggle`) with a token (the owner
 * step), git, and for the held-out sets the evaluator's key (plan W6.17).
 * $LUMEN_KAGGLE_CLI replaces the `kaggle` binary (tests use a fake one).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { DICTATION_STEPS, acceptance, checkCloudReport, datasetId, datasetMetadata, dictationVerdict, kernelId, kernelMetadata, measuredWerFrom, parseStatus, runConfig, runSigningKey } from "./lib/modelsCloud.mjs";
import { generateKey } from "./lib/heldout.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const FLAGS = new Set(["--no-heldout", "--no-wait", "--push", "--no-push", "--allow-wiring", "--force"]);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) positional.push(a);
  else if (FLAGS.has(a)) opts[a.slice(2)] = true;
  else if (a.includes("=")) opts[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
  else opts[a.slice(2)] = argv[++i];
}
let command = positional[0] ?? "run";
// Plan W6.19: the dictation measurement is a run of just its steps, pushed unless --no-push.
const dictation = command === "dictation";
if (dictation) {
  if (opts.only || opts.skip) die("dictation picks its own steps; drop --only / --skip");
  if (opts["no-heldout"]) die("dictation needs the held-out asr-he set (plan W6.17): run where the evaluator key is");
  opts.only = DICTATION_STEPS.join(",");
  if (!opts["no-push"]) opts.push = true;
  command = "run";
}
const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};
const STATE = resolve(process.env.LUMEN_CLOUD_DIR ?? join(homedir(), ".cache", "lumen-cloud"));
if (STATE === ROOT || STATE.startsWith(ROOT + "/")) die("the run state folder must be outside the repo");
const KAGGLE = process.env.LUMEN_KAGGLE_CLI ?? "kaggle";
const kaggle = (args, { quiet = false } = {}) => {
  const r = spawnSync(KAGGLE, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (!quiet && r.status !== 0) die(`kaggle ${args.slice(0, 2).join(" ")} failed (${r.status ?? r.error?.code}): ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`, 3);
  return r;
};
const git = (args, cwd = ROOT) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const OWNER_STEP = `The one owner step (about 5 minutes, once):
  1. Sign in at https://www.kaggle.com (any Google account works).
  2. Settings → Phone verification: verify a phone number (Kaggle needs it for GPUs and internet in notebooks).
  3. Settings → API → "Create New Token": put the downloaded kaggle.json at ~/.kaggle/kaggle.json
     (chmod 600) on the machine that runs this command — or set KAGGLE_USERNAME and KAGGLE_KEY.
Then: pip install kaggle, and \`npm run models:cloud\`.`;

function kaggleUser() {
  if (opts.user) return String(opts.user);
  if (process.env.KAGGLE_USERNAME) return process.env.KAGGLE_USERNAME;
  const f = join(process.env.KAGGLE_CONFIG_DIR ?? join(homedir(), ".kaggle"), "kaggle.json");
  if (existsSync(f)) {
    try {
      return JSON.parse(readFileSync(f, "utf8")).username ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

// ── setup ─────────────────────────────────────────────────────────────────

if (command === "setup") {
  const user = kaggleUser();
  const cli = spawnSync(KAGGLE, ["--version"], { encoding: "utf8" });
  const auth = cli.status === 0 && user ? kaggle(["kernels", "list", "--mine", "--page-size", "1"], { quiet: true }) : null;
  const key = !!process.env.LUMEN_HELDOUT_KEY || existsSync(join(homedir(), ".config", "lumen-heldout", "key"));
  const rows = [
    [cli.status === 0, `Kaggle CLI (${cli.status === 0 ? cli.stdout.trim() : "not found"})`, "pip install kaggle"],
    [!!user, `Kaggle account token (${user ?? "none"})`, "the owner step below"],
    [auth?.status === 0, "the token works (kaggle kernels list --mine)", "a new token: Settings → API → Create New Token"],
    [key, "the held-out evaluator key (plan W6.17), for the held-out sets", "npm run heldout -- keygen, once (or pass --no-heldout)"],
  ];
  for (const [ok, text, fix] of rows) console.log(`  ${ok ? "✓" : "✗"} ${text}${ok ? "" : `\n      → ${fix}`}`);
  console.log(`\n${OWNER_STEP}\n\nGPU and internet need the phone verification; Kaggle reports it on the first push if it is missing.`);
  process.exit(rows.slice(0, 3).every((r) => r[0]) ? 0 : 1);
}

// ── mac: the backup ───────────────────────────────────────────────────────

if (command === "mac") {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/models-day.mjs"), ...argv.slice(1)], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 1);
}

// ── run ───────────────────────────────────────────────────────────────────

function stateOf(runId) {
  const f = join(STATE, runId, "run-local.json");
  if (!existsSync(f)) die(`no run ${runId} in ${STATE}`);
  return JSON.parse(readFileSync(f, "utf8"));
}

if (command === "run") {
  const user = kaggleUser();
  if (!user) die(`No Kaggle account on this machine.\n\n${OWNER_STEP}`);
  const ref = String(opts.ref ?? "HEAD");
  const commit = git(["rev-parse", `${ref}^{commit}`]).stdout.trim();
  if (!commit) die(`unknown ref ${ref}`);
  const onOrigin = git(["branch", "-r", "--contains", commit]).stdout.trim();
  if (!onOrigin && !opts.force) die(`${commit.slice(0, 9)} is not on any pushed branch: the cloud clones from GitHub. Push it first (or pass --force).`);
  const repo = String(opts.repo ?? "talstilkol/lumen-md");
  const runId = String(opts.run ?? `cloud-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
  const dir = join(STATE, runId);
  if (existsSync(join(dir, "run-local.json"))) die(`run ${runId} exists; fetch it (npm run models:cloud -- fetch ${runId}) or pick another --run`);
  const stage = join(dir, "dataset");
  const kdir = join(dir, "kernel");
  mkdirSync(stage, { recursive: true });
  mkdirSync(kdir, { recursive: true });
  const signing = runSigningKey();
  let heldout = null;
  if (!opts["no-heldout"]) {
    const hasKey = !!process.env.LUMEN_HELDOUT_KEY || existsSync(join(homedir(), ".config", "lumen-heldout", "key"));
    if (!hasKey) die("No held-out evaluator key here (plan W6.17): run where the key is, or pass --no-heldout.");
    const runKey = generateKey();
    const ex = spawnSync(process.execPath, [join(ROOT, "scripts/heldout.mjs"), "export", "--to", runKey.recipient, "--out", join(stage, "heldout.lho")], { encoding: "utf8", cwd: ROOT, env: { ...process.env, LUMEN_HELDOUT_REQUESTER: `${requester()} → kaggle ${runId}` } });
    if (ex.status !== 0) die(`npm run heldout -- export failed: ${ex.stderr.trim()}`);
    console.log(ex.stdout.trim());
    heldout = { key: runKey.secret, file: "heldout.lho" };
  }
  const cfg = runConfig({ runId, repo, commit, requester: requester(), signing, heldout, only: list(opts.only), skip: list(opts.skip) });
  writeFileSync(join(stage, "run.json"), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(stage, "dataset-metadata.json"), JSON.stringify(datasetMetadata(user, runId), null, 2) + "\n");
  copyFileSync(join(ROOT, "scripts/cloud/kaggle_kernel.py"), join(kdir, "run.py"));
  writeFileSync(join(kdir, "kernel-metadata.json"), JSON.stringify(kernelMetadata(user, runId), null, 2) + "\n");
  writeFileSync(join(dir, "run-local.json"), JSON.stringify({ runId, user, commit, ref, repo, kernel: kernelId(user), dataset: datasetId(user, runId), publicPem: signing.publicPem, heldout: !!heldout, dictation, startedAt: new Date().toISOString() }, null, 2) + "\n");

  console.log(`Run ${runId}: commit ${commit.slice(0, 9)} (${ref}) on Kaggle as ${user}${heldout ? ", with the held-out sets" : ""}`);
  kaggle(["datasets", "create", "-p", stage, "--dir-mode", "zip", "-q"]);
  // The run's secrets are on Kaggle now (private dataset); the local copy is not needed.
  rmSync(stage, { recursive: true, force: true });
  for (let i = 0; i < 60; i++) {
    if (/ready/i.test(kaggle(["datasets", "status", datasetId(user, runId)], { quiet: true }).stdout)) break;
    spawnSync("sleep", ["5"]);
  }
  kaggle(["kernels", "push", "-p", kdir]);
  console.log(`Pushed ${kernelId(user)} (private, ${kernelMetadata(user, runId).machine_shape}, internet on).`);
  if (opts["no-wait"]) {
    console.log(`Not waiting. Later: npm run models:cloud -- fetch ${runId}`);
    process.exit(0);
  }
  const pollMs = Number(opts["poll-seconds"] ?? 60) * 1000;
  const deadline = Date.now() + 13 * 3600 * 1000; // Kaggle stops a session after 12 hours
  let status = "unknown";
  while (Date.now() < deadline) {
    status = parseStatus(kaggle(["kernels", "status", kernelId(user)], { quiet: true }).stdout);
    if (["complete", "error", "cancelled"].includes(status)) break;
    spawnSync("sleep", [String(Math.max(1, pollMs / 1000))]);
  }
  console.log(`Kaggle: ${status}`);
  fetchRun(runId);
}

function requester() {
  let u = "unknown";
  try {
    u = userInfo().username;
  } catch {
    /* no user */
  }
  return String(process.env.LUMEN_HELDOUT_REQUESTER ?? `${u}@${hostname()}`);
}

// ── fetch / status ────────────────────────────────────────────────────────

function fetchRun(runId) {
  const st = stateOf(runId);
  const tmp = mkdtempSync(join(tmpdir(), "lumen-cloud-"));
  try {
    kaggle(["kernels", "output", st.kernel, "-p", tmp, "-o", "-q"]);
    const cloud = existsSync(join(tmp, "cloud.json")) ? JSON.parse(readFileSync(join(tmp, "cloud.json"), "utf8")) : null;
    if (!existsSync(join(tmp, "results.tar.gz"))) die(`no results.tar.gz in the kernel's output (phase: ${cloud?.phase ?? "?"}). Its log is on Kaggle: ${st.kernel}`, 1);
    const unpack = join(tmp, "x");
    mkdirSync(unpack);
    const t = spawnSync("tar", ["-xzf", join(tmp, "results.tar.gz"), "-C", unpack, "--no-same-owner"], { encoding: "utf8" });
    if (t.status !== 0) die(`could not unpack results.tar.gz: ${t.stderr}`, 1);
    const runDir = join(unpack, runId);
    if (!existsSync(join(runDir, "report.json"))) die(`the archive holds no ${runId}/report.json`, 1);
    const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
    const problems = checkCloudReport(report, runDir, st, { allowWiring: !!opts["allow-wiring"] });
    if (problems.length) {
      for (const p of problems) console.error(`✗ ${p}`);
      die("The report is not accepted.", 1);
    }
    const out = resolve(opts.results ?? join(ROOT, "eval/results/day"), runId);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(runDir, out, { recursive: true });
    if (cloud) writeFileSync(join(out, "cloud.json"), JSON.stringify(cloud, null, 2) + "\n");
    const a = acceptance(report);
    console.log(`✓ ${runId}: receipt intact, signed by this run's key, commit ${st.commit.slice(0, 9)}${report.kind === "model" ? `, GPU ${report.host?.gpu}` : " — WIRING run (fake Ollama), not a model score"}`);
    console.log(`  steps: ${a.pass} pass, ${a.fail} fail · models with a digest: ${a.modelsWithDigest} (${a.fourModels ? "≥ 4 ✓" : "< 4"}) · tool calls: ${a.toolCallTarget} · tasks measured: ${a.tasksMeasured.length}${a.tenTasks ? " (≥ 10 ✓)" : ""}`);
    // Plan W6.19: which dictation path reaches its target, on which device, in plain numbers.
    const dv = dictationVerdict(report);
    console.log("  dictation (W6.19), held-out asr-he else FLEURS-he validation:");
    for (const r of dv.rows) console.log(`    ${r.path}: ${r.verdict}${r.fleurs !== null && r.heldout !== null ? ` (FLEURS ${(r.fleurs * 100).toFixed(1)} %)` : ""}`);
    if (dv.desktopFallback) console.log("    → the phone misses 15 % and the desktop meets it: \"send to my desktop\" is the phone's way to the target");
    if (cloud?.whisperGgml?.sha256) {
      const g = cloud.whisperGgml;
      console.log(`  the ggml file measured (pin it with: npm run whisper:desktop -- pin --repo ${g.repo} --revision ${g.revision} --file ${g.file} --bytes ${g.bytes} --sha256 ${g.sha256}; licence ${g.license ?? "?"})`);
    }
    // What "send to my desktop" reads (desktopOffload.ts MEASURED_WER): measured numbers only.
    const measured = measuredWerFrom(report, st);
    if (Object.keys(measured).length) {
      writeFileSync(join(out, "measuredWer.json"), JSON.stringify(measured, null, 2) + "\n");
      console.log(`  measured WER for the app: ${Object.entries(measured).map(([e, m]) => `${e} ${(m.wer * 100).toFixed(1)} % (${m.split})`).join(" · ")}`);
    }
    console.log(`  → ${out}`);
    const branch = `eval/day-${runId}`;
    const rel = `eval/results/day/${runId}`;
    if (opts.push) {
      const wt = mkdtempSync(join(tmpdir(), "lumen-eval-"));
      const steps = [
        ["worktree", "add", "-q", "-b", branch, wt, st.commit],
        ["-C", wt, "add", "-f", rel],
      ];
      if (git(steps[0]).status !== 0) die(`git worktree add ${branch} failed`, 1);
      cpSync(out, join(wt, rel), { recursive: true });
      spawnSync("git", steps[1], { encoding: "utf8" });
      // A dictation run also updates the numbers the app reads, so the branch is ready for review as it is.
      const appFile = join(wt, "src/ai/dictation/measuredWer.json");
      if (st.dictation && Object.keys(measured).length && existsSync(appFile)) {
        const merged = { ...JSON.parse(readFileSync(appFile, "utf8")), ...measured };
        writeFileSync(appFile, JSON.stringify(merged, null, 2) + "\n");
        spawnSync("git", ["-C", wt, "add", "src/ai/dictation/measuredWer.json"], { encoding: "utf8" });
      }
      const msg = st.dictation ? `eval: Hebrew dictation WER ${runId} on a Kaggle GPU, measuredWer.json from it (plan W6.19) [skip ci]` : `eval: real models day ${runId} on a Kaggle GPU (plan W6.18) [skip ci]`;
      const c = spawnSync("git", ["-C", wt, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg], { encoding: "utf8" });
      const p = c.status === 0 ? spawnSync("git", ["-C", wt, "push", "-q", "-u", "origin", branch], { encoding: "utf8" }) : c;
      console.log(p.status === 0 ? `  pushed ${branch}` : `  could not commit or push ${branch}: ${(p.stderr || "").trim()}`);
      git(["worktree", "remove", "--force", wt]);
    } else if (report.kind === "model") {
      console.log(`\nSend it to plan 7.9 / W6.7: npm run models:cloud -- fetch ${runId} --push\n  (or: git switch -c ${branch} && git add -f ${rel} && git commit -m "eval: real models day ${runId} [skip ci]" && git push -u origin HEAD)`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

if (command === "fetch") fetchRun(positional[1] ?? die("usage: npm run models:cloud -- fetch <run>"));
if (command === "status") {
  const st = stateOf(positional[1] ?? die("usage: npm run models:cloud -- status <run>"));
  console.log(`${st.runId}: ${parseStatus(kaggle(["kernels", "status", st.kernel], { quiet: true }).stdout)} (${st.kernel}, commit ${st.commit.slice(0, 9)})`);
  process.exit(0);
}
if (!["run", "setup", "mac", "fetch", "status"].includes(command)) die(`unknown command "${command}" — setup, run, dictation, fetch, status or mac`);
