#!/usr/bin/env node
// Real tiny model run (plan 7.2): every agent once against a real local
// model on CPU, judged on structure (src/agents/eval/real.eval.ts).
//
//   npm run ci:real-model                       # qwen3:0.6b, Ollama on 127.0.0.1:11434
//   npm run ci:real-model -- --model qwen3:1.7b # the nightly multi-step model
//
// It finds Ollama (or starts `ollama serve` when the binary is installed),
// pulls the model when it is missing, then runs the eval. When any of that
// is impossible here — no Ollama, no network to the registry, no disk — it
// says why, writes a "skipped" report and exits 0: a machine without the
// model is not a failing build. LUMEN_REAL_MODEL_REQUIRED=1 turns a skip
// into a failure (the nightly job, where the model is cached).
//
// Writes eval/results/real-<date>-<model>.md (+ .json), or real-skipped.md.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return fallback;
  return args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
};
const model = opt("model", process.env.LUMEN_REAL_MODEL || "qwen3:0.6b");
const url = (opt("url", process.env.LUMEN_REAL_OLLAMA_URL || "http://127.0.0.1:11434")).replace(/\/+$/, "");
const out = opt("out", process.env.LUMEN_EVAL_OUT || "eval/results");
const pullTimeoutMs = Number(opt("pull-timeout", process.env.LUMEN_REAL_PULL_TIMEOUT_MS || 10 * 60_000));
const required = process.env.LUMEN_REAL_MODEL_REQUIRED === "1";

function skip(reason) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "real-skipped.md"), `# Real tiny model — skipped\n\n${new Date().toISOString()} · ${model} @ ${url}\n\n**Skipped:** ${reason}\n`);
  console.log(`real-model: skipped — ${reason}`);
  process.exit(required ? 1 : 0);
}

async function reachable() {
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

let server = null;
async function ensureOllama() {
  let tags = await reachable();
  if (tags) return tags;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ollama"], { encoding: "utf8" });
  if (which.status !== 0) skip(`Ollama is not running at ${url} and the \`ollama\` binary is not installed (https://ollama.com/download).`);
  const host = new URL(url);
  server = spawn("ollama", ["serve"], { env: { ...process.env, OLLAMA_HOST: `${host.hostname}:${host.port || 11434}` }, stdio: "ignore", detached: false });
  for (let i = 0; i < 40 && !tags; i++) {
    await new Promise((r) => setTimeout(r, 500));
    tags = await reachable();
  }
  if (!tags) skip(`started \`ollama serve\`, but ${url} did not answer within 20 s.`);
  return tags;
}

async function ensureModel(tags) {
  const names = (tags.models ?? []).map((m) => m.name);
  if (names.includes(model) || names.includes(`${model}:latest`)) return;
  console.log(`real-model: pulling ${model}…`);
  try {
    const r = await fetch(`${url}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: false }), signal: AbortSignal.timeout(pullTimeoutMs) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) skip(`could not pull ${model}: ${body.error ?? `HTTP ${r.status}`} (no network to the model registry here?).`);
  } catch (e) {
    skip(`could not pull ${model}: ${e.message} (no network to the model registry here?).`);
  }
}

const tags = await ensureOllama();
await ensureModel(tags);
const t0 = Date.now();
const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.eval.config.ts", "--reporter", "dot", "src/agents/eval/real.eval.ts"], {
  stdio: "inherit",
  env: { ...process.env, LUMEN_REAL_MODEL: model, LUMEN_REAL_OLLAMA_URL: url, LUMEN_EVAL_OUT: out },
  shell: process.platform === "win32",
});
console.log(`real-model: ${model} — ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (server) server.kill();
process.exit(r.status ?? 1);
