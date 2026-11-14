#!/usr/bin/env node
/**
 * Real models day (plan W4.6): every real-model eval the plan owes, in one
 * command, on a machine with Ollama and a GPU.
 *
 *   npm run models:day -- check        what to install (exact model tags), nothing runs
 *   npm run models:day -- plan         the steps, what each measures, the declared time
 *   npm run models:day                 pull the missing models, run every step, write the report
 *   npm run models:day -- verify eval/results/day/<run>/report.json
 *
 * Options
 *   --url URL          Ollama (default $OLLAMA_URL or http://127.0.0.1:11434)
 *   --out DIR          results root (default eval/results/day)
 *   --only a,b         just these steps · --skip a,b · --with dictalm3 (optional steps)
 *   --redo a,b         run these again even when the resumed run has them
 *   --fresh            start a new run instead of resuming the last unfinished one
 *   --no-pull          never pull a model (a step whose model is missing fails)
 *   --meetings-dir D   the owner's meeting recordings (15.11) for the meetings step
 *   --voice-dir D      the owner's recorded voice commands (W5.20) for the voice-commands step
 *   --cache DIR        downloads (ASR model, FLEURS clips); default ~/.cache/lumen-models-day
 *   --sign-key PEM     an Ed25519 private key: the receipt is also signed
 *   --heldout-key-file F   the held-out evaluator's key (or $LUMEN_HELDOUT_KEY): adds the held-out step (plan W6.17)
 *   --yes              run even when the checklist has open items
 *
 * Resumable: each step's result is saved as it finishes; stop with Ctrl-C and
 * run the same command again to continue. Each step writes into
 * <out>/<run>/<step>/ (its eval's own files + log.txt); report.json lists
 * every file with its sha256, the commit, the machine and each model's
 * Ollama digest, sealed by a sha256 receipt (and a signature with
 * --sign-key). Against the fake server (scripts/fake-ollama.mjs) the whole
 * report is labelled a wiring run, never a model score.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync, createWriteStream } from "node:fs";
import { cpus, homedir, platform, arch, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { COVERAGE, STEPS, artifacts, availability, checklist, declaredMinutes, formatReport, judge, pendingSteps, seal, selectSteps, verifyReport } from "./lib/modelsDay.mjs";

const argv = process.argv.slice(2);
const flags = new Set(["--fresh", "--no-pull", "--yes"]);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) positional.push(a);
  else if (flags.has(a)) opts[a.slice(2)] = true;
  else if (a.includes("=")) opts[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
  else opts[a.slice(2)] = argv[++i];
}
const command = positional[0] ?? "run";
const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const url = String(opts.url ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const outRoot = resolve(opts.out ?? "eval/results/day");
const cache = resolve(opts.cache ?? join(homedir(), ".cache", "lumen-models-day"));
const root = process.cwd();
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
const known = new Set(STEPS.map((s) => s.id));
for (const id of [...list(opts.only), ...list(opts.skip), ...list(opts.with), ...list(opts.redo)]) {
  if (!known.has(id)) {
    console.error(`unknown step "${id}" — steps: ${[...known].join(", ")}`);
    process.exit(2);
  }
}

if (command === "verify") {
  const file = positional[1];
  if (!file) {
    console.error("usage: npm run models:day -- verify <run>/report.json");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(file, "utf8"));
  const problems = verifyReport(report, dirname(resolve(file)));
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  const files = report.steps.reduce((n, s) => n + (s.artifacts?.length ?? 0), 0);
  console.log(`✓ ${report.runId}: receipt ${report.receipt.digest.slice(0, 16)}… intact, ${files} files match${report.receipt.signature ? ", signature valid" : ""} (${report.kind === "model" ? "real models" : "WIRING run — not a model score"})`);
  process.exit(0);
}
if (!["run", "check", "plan"].includes(command)) {
  console.error(`unknown command "${command}" — run, check, plan or verify`);
  process.exit(2);
}

// ── preflight ─────────────────────────────────────────────────────────────

async function getJson(path, init) {
  const r = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000), ...init });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
async function ollamaInfo() {
  try {
    const v = await getJson("/api/version");
    const t = await getJson("/api/tags");
    const digests = Object.fromEntries((t.models ?? []).map((m) => [m.name, m.digest ?? null]));
    return { version: v.version ?? "0", fake: !!v.lumen_fake, models: Object.keys(digests), digests };
  } catch {
    return null;
  }
}
const run1 = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000, shell: platform() === "win32" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const which = (bin) => !!run1(platform() === "win32" ? "where" : "which", [bin]);
function gpu() {
  if (platform() === "darwin") {
    const chip = run1("sysctl", ["-n", "machdep.cpu.brand_string"]);
    return chip && /Apple/.test(chip) ? `${chip} (unified memory, Metal)` : run1("system_profiler", ["SPDisplaysDataType"])?.match(/Chipset Model: (.+)/)?.[1] ?? null;
  }
  const nv = which("nvidia-smi") ? run1("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]) : null;
  if (nv) return nv.split("\n")[0];
  const amd = which("rocm-smi") ? run1("rocm-smi", ["--showproductname"])?.match(/Card series:\s*(.+)/)?.[1] : null;
  return amd ?? null;
}
function chromium() {
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), ".cache", "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright"), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright")].filter(Boolean);
  return dirs.some((d) => existsSync(d) && spawnSync("ls", [d], { encoding: "utf8" }).stdout?.includes("chromium"));
}
function diskFreeGB(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const s = statfsSync(dir);
    return Math.round((s.bavail * s.bsize) / 1e9);
  } catch {
    return null;
  }
}

const ollama = await ollamaInfo();
const env = {
  url,
  node: process.versions.node,
  nodeModules: existsSync(join(root, "node_modules", ".package-lock.json")) || existsSync(join(root, "node_modules", "vitest")),
  ollama,
  gpu: gpu(),
  tools: { python3: which("python3") && spawnSync("python3", ["-I", "-c", "import huggingface_hub, pyarrow"], { timeout: 20_000 }).status === 0, ffmpeg: which("ffmpeg"), chromium: chromium() },
  diskFreeGB: diskFreeGB(outRoot),
};
// The held-out sets (plan W6.17) run whenever the evaluator key is here: Tal's or the nightly host's.
if (opts["heldout-key-file"] && !process.env.LUMEN_HELDOUT_KEY) process.env.LUMEN_HELDOUT_KEY = readFileSync(opts["heldout-key-file"], "utf8").trim();
const heldoutKey = !!process.env.LUMEN_HELDOUT_KEY;
const withOptional = [...list(opts.with), ...(heldoutKey && !list(opts.skip).includes("heldout") ? ["heldout"] : [])];
const heldoutStore = resolve(process.env.LUMEN_HELDOUT_DIR ?? join(homedir(), ".cache", "lumen-heldout"));
const selected = selectSteps(STEPS, { only: list(opts.only), skip: list(opts.skip), withOptional }).map((s) => ({ ...s, available: availability(s, { scripts, root, options: { meetingsDir: opts["meetings-dir"], voiceDir: opts["voice-dir"], heldoutKey } }) }));
const items = checklist(selected, env);
const open = items.filter((i) => !i.ok);

console.log(`\nReal models day (plan W4.6) — ${selected.filter((s) => s.available.ok).length} of ${selected.length} steps runnable on this branch, declared ${declaredMinutes(selected)} min of machine time\n`);
console.log("Checklist:");
for (const i of items) console.log(`  ${i.ok ? "✓" : "✗"} ${i.text}${i.ok || !i.fix ? "" : `\n      → ${i.fix}`}`);
console.log("\nYour part (≈ 15 min by hand): install what is ✗ above, start `npm run models:day`, leave it running, then send the run folder back (the command prints how).");

if (command === "plan" || command === "check") {
  console.log("\nSteps:");
  for (const s of selected) console.log(`  ${s.available.ok ? "•" : "–"} ${s.id.padEnd(14)} ${String(s.minutes).padStart(3)} min  ${s.title}  [plan ${s.plan.join(", ")}]${s.available.ok ? "" : `\n${" ".repeat(24)}${s.available.reason}`}`);
  process.exit(command === "check" && open.length ? 1 : 0);
}

if (!ollama) {
  console.error(`\nOllama does not answer at ${url}. Start it (\`ollama serve\`) or pass --url.`);
  process.exit(2);
}
const blocking = open.filter((i) => !/^model /.test(i.text));
if (blocking.length && !opts.yes) {
  console.error(`\n${blocking.length} checklist item(s) are open. Fix them, or pass --yes to run anyway (the steps that need them will fail and say so).`);
  process.exit(2);
}

// ── the run ───────────────────────────────────────────────────────────────

mkdirSync(outRoot, { recursive: true });
const latestFile = join(outRoot, "latest.json");
const latest = existsSync(latestFile) ? JSON.parse(readFileSync(latestFile, "utf8")) : null;
const runId = opts.run ?? (!opts.fresh && latest && !latest.finished ? latest.runId : new Date().toISOString().slice(0, 16).replace(/:/g, "-"));
const runDir = join(outRoot, runId);
mkdirSync(runDir, { recursive: true });
const stateFile = join(runDir, "state.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { runId, startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
writeFileSync(latestFile, JSON.stringify({ runId, finished: false }, null, 2) + "\n");
const resumed = Object.keys(state.steps).length > 0;
console.log(`\n${resumed ? "Resuming" : "Starting"} run ${runId} → ${runDir}${ollama.fake ? "\n⚠ Ollama is the FAKE server: this is a wiring run, not a model score." : ""}`);

const modelDigests = { ...(state.models ?? {}) };
async function ensureModel(tag) {
  const info = await ollamaInfo();
  if (info && (info.models.includes(tag) || info.models.includes(`${tag}:latest`))) return true;
  if (opts["no-pull"]) return false;
  console.log(`  pulling ${tag}…`);
  try {
    const r = await fetch(`${url}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: tag, stream: true }) });
    const text = await r.text();
    const last = text.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).pop() ?? {};
    if (!r.ok || last.error) {
      console.error(`  could not pull ${tag}: ${last.error ?? `HTTP ${r.status}`}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`  could not pull ${tag}: ${e.message}`);
    return false;
  }
}

let child = null;
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  if (child) child.kill("SIGINT");
});

function exec({ cmd, args, env: extra = {} }, log) {
  return new Promise((done) => {
    log.write(`\n$ ${cmd} ${args.join(" ")}\n`);
    console.log(`  $ ${cmd} ${args.join(" ")}`);
    child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"], shell: platform() === "win32" });
    const tee = (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    child.on("error", (e) => {
      log.write(`\n${e.message}\n`);
      done(127);
    });
    child.on("close", (code, signal) => {
      child = null;
      done(code ?? (signal ? 130 : 1));
    });
  });
}

async function gpuOffload(models) {
  // Ollama's /api/ps: how much of each loaded model sits in GPU memory.
  try {
    const ps = await getJson("/api/ps");
    return Object.fromEntries((ps.models ?? []).filter((m) => models.includes(m.name) || models.includes(m.name.replace(/:latest$/, ""))).map((m) => [m.name, m.size ? Math.round((100 * (m.size_vram ?? 0)) / m.size) : null]));
  } catch {
    return {};
  }
}

const todo = new Set(pendingSteps(selected, state, list(opts.redo)).map((s) => s.id));
for (const step of selected) {
  if (stopping) break;
  if (!step.available.ok) {
    state.steps[step.id] = { status: step.available.status, reason: step.available.reason };
    save();
    continue;
  }
  if (!todo.has(step.id)) {
    console.log(`\n■ ${step.id}: ${state.steps[step.id].status} in an earlier session — kept (--redo ${step.id} to run it again)`);
    continue;
  }
  console.log(`\n▶ ${step.id} — ${step.title} (declared ${step.minutes} min)`);
  const dir = join(runDir, step.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  state.steps[step.id] = { status: "running", startedAt };
  save();
  const t0 = Date.now();
  let exit = 0;
  const missing = [];
  for (const m of step.models) if (!(await ensureModel(m))) missing.push(m);
  const log = createWriteStream(join(dir, "log.txt"));
  if (missing.length) {
    exit = 3;
    log.write(`missing model(s): ${missing.join(", ")} — ollama pull ${missing.join(" && ollama pull ")}\n`);
  } else {
    for (const c of step.commands({ url, dir, cache, meetingsDir: opts["meetings-dir"], voiceDir: opts["voice-dir"], heldoutStore })) {
      if (c.skipIf?.()) continue;
      exit = await exec(c, log);
      if (exit !== 0 || stopping) break;
    }
  }
  await new Promise((r) => log.end(r));
  const ms = Date.now() - t0;
  if (stopping) {
    state.steps[step.id] = { status: "interrupted", startedAt, ms };
    save();
    break;
  }
  const info = await ollamaInfo();
  for (const m of step.models) modelDigests[m] = info?.digests[m] ?? info?.digests[`${m}:latest`] ?? null;
  state.models = modelDigests;
  let metrics = null;
  try {
    metrics = step.parse(dir);
  } catch (e) {
    metrics = { parseError: e.message };
  }
  const status = judge(step, exit, metrics);
  // Hashed now, so a file changed between this session and a resumed one fails `verify`.
  state.steps[step.id] = { status, exit, startedAt, ms, metrics, gpuOffloadPct: await gpuOffload(step.models), ...(missing.length ? { reason: `missing model(s): ${missing.join(", ")}` } : {}), artifacts: artifacts(dir, runDir) };
  save();
  console.log(`■ ${step.id}: ${status} (exit ${exit}, ${(ms / 60000).toFixed(1)} min)`);
}

// ── the report ────────────────────────────────────────────────────────────

const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const finished = !stopping && selected.every((s) => state.steps[s.id] && state.steps[s.id].status !== "running" && state.steps[s.id].status !== "interrupted");
const report = seal(
  {
    schema: 1,
    plan: "W4.6",
    runId,
    kind: ollama.fake ? "wiring" : "model",
    finished,
    startedAt: state.startedAt,
    writtenAt: new Date().toISOString(),
    git: { commit: git(["rev-parse", "HEAD"]).stdout?.trim() || null, branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout?.trim() || null, dirty: !!git(["status", "--porcelain", "--untracked-files=no"]).stdout?.trim() },
    host: { platform: platform(), arch: arch(), cpus: cpus().length, ramGB: Math.round(totalmem() / 1e9), gpu: env.gpu, node: process.versions.node },
    ollama: { url, version: ollama.version, fake: ollama.fake },
    models: modelDigests,
    declaredMinutes: declaredMinutes(selected),
    actualMinutes: Math.round(selected.reduce((n, s) => n + (state.steps[s.id]?.ms ?? 0), 0) / 6000) / 10,
    // The selected steps plus any this run finished in an earlier session (a resume with --only).
    steps: STEPS.filter((s) => selected.some((x) => x.id === s.id) || state.steps[s.id]).map((s) => ({
      id: s.id,
      title: s.title,
      plan: s.plan,
      target: s.target?.text,
      minutes: s.minutes,
      artifacts: [],
      ...(state.steps[s.id] ?? { status: "not-run" }),
    })),
    coverage: COVERAGE,
  },
  opts["sign-key"] ? readFileSync(opts["sign-key"], "utf8") : null,
);
writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(runDir, "report.md"), formatReport(report));
writeFileSync(latestFile, JSON.stringify({ runId, finished }, null, 2) + "\n");

const count = (st) => report.steps.filter((s) => s.status === st).length;
console.log(`\n${finished ? "Done" : "Stopped — run the same command to continue"}: ${count("pass")} pass, ${count("fail")} fail, ${count("unavailable")} unavailable, ${count("blocked")} blocked. Report: ${join(runDir, "report.md")}`);
console.log(`Receipt sha256 ${report.receipt.digest}${report.receipt.signature ? " (signed)" : ""}`);
if (finished && report.kind === "model") {
  console.log(`\nSend it back (plan 7.9): commit the folder on a branch —\n  git switch -c eval/day-${runId} && git add -f ${join(opts.out ?? "eval/results/day", runId)} && git commit -m "eval: real models day ${runId} [skip ci]" && git push -u origin HEAD`);
}
process.exit(stopping ? 130 : 0);
