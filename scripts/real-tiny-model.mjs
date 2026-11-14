#!/usr/bin/env node
// Real tiny model run (plan 7.2): every agent once against a real local
// model on CPU, judged on structure (src/agents/eval/real.eval.ts).
//
//   npm run ci:real-model                       # qwen3:0.6b, Ollama on 127.0.0.1:11434
//   npm run ci:real-model -- --model qwen3:1.7b # the nightly multi-step model
//   npm run ci:real-model -- --hebrew-smoke     # DictaLM 3.0 1.7B on short Hebrew prompts (7.2.2)
//   npm run ci:real-model -- --digest sha256:…  # refuse any other build of the model (7.2.3)
//
// It finds Ollama (or starts `ollama serve` when the binary is installed),
// pulls the model when it is missing, then runs the eval. When any of that
// is impossible here — no Ollama, no network to the registry, no disk — it
// says why, writes a "skipped" report and exits 0: a machine without the
// model is not a failing build. LUMEN_REAL_MODEL_REQUIRED=1 turns a skip
// into a failure (the nightly job, where the model is cached).
//
// Ollama stores each model by its content digest. The run prints the digest
// it used and writes it into the report; LUMEN_REAL_MODEL_DIGEST (or
// --digest) pins it, and a different local build then fails the run instead
// of being measured under the same name.
//
// Writes eval/results/real-<date>-<model>.md (+ .json), or real-skipped.md;
// with --hebrew-smoke, real-hebrew-<date>-<model>.md (+ .json).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEBREW_SMOKE_MODEL, HEBREW_SMOKE_PROMPTS, digestMismatch, findModel, formatHebrewSmokeReport, judgeHebrewAnswer, normalizeDigest } from "./lib/real-model.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return fallback;
  return args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
};
const hebrewSmoke = args.includes("--hebrew-smoke");
const model = hebrewSmoke ? opt("model", process.env.LUMEN_REAL_HEBREW_MODEL || HEBREW_SMOKE_MODEL) : opt("model", process.env.LUMEN_REAL_MODEL || "qwen3:0.6b");
const pinnedDigest = opt("digest", process.env.LUMEN_REAL_MODEL_DIGEST || "");
const url = (opt("url", process.env.LUMEN_REAL_OLLAMA_URL || "http://127.0.0.1:11434")).replace(/\/+$/, "");
const out = opt("out", process.env.LUMEN_EVAL_OUT || "eval/results");
const pullTimeoutMs = Number(opt("pull-timeout", process.env.LUMEN_REAL_PULL_TIMEOUT_MS || 10 * 60_000));
const required = process.env.LUMEN_REAL_MODEL_REQUIRED === "1";

function skip(reason) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, hebrewSmoke ? "real-hebrew-skipped.md" : "real-skipped.md"), `# ${hebrewSmoke ? "Hebrew smoke test" : "Real tiny model"} — skipped\n\n${new Date().toISOString()} · ${model} @ ${url}\n\n**Skipped:** ${reason}\n`);
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

/** The digest the run uses (printed and recorded); a pinned digest that differs stops it. */
async function checkDigest() {
  const entry = findModel(await reachable(), model);
  const digest = normalizeDigest(entry?.digest);
  console.log(`real-model: ${model} digest ${digest || "unknown"}`);
  const mismatch = digestMismatch(entry, pinnedDigest);
  if (mismatch) {
    console.error(`real-model: ${mismatch}`);
    if (server) server.kill();
    process.exit(1);
  }
  return digest;
}

/** One Hebrew prompt, temperature 0 and a fixed seed; without the thinking phase when the model allows it. */
async function chatOnce(prompt) {
  const body = (think) => JSON.stringify({ model, stream: false, ...(think === undefined ? {} : { think }), messages: [{ role: "user", content: prompt }], options: { temperature: 0, seed: 42, num_predict: 256 } });
  let r = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body(false), signal: AbortSignal.timeout(5 * 60_000) });
  let json = await r.json().catch(() => ({}));
  // Models whose template has no thinking switch reject `think`; ask again without it.
  if (!r.ok && /think/i.test(String(json.error ?? ""))) {
    r = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body(undefined), signal: AbortSignal.timeout(5 * 60_000) });
    json = await r.json().catch(() => ({}));
  }
  if (!r.ok || json.error) throw new Error(json.error ?? `HTTP ${r.status}`);
  return String(json.message?.content ?? "");
}

async function hebrewSmokeRun(digest) {
  const results = [];
  const t0 = Date.now();
  for (const item of HEBREW_SMOKE_PROMPTS) {
    const started = Date.now();
    let answer = "";
    let verdict;
    try {
      answer = await chatOnce(item.prompt);
      verdict = judgeHebrewAnswer(item, answer);
    } catch (e) {
      verdict = { ok: false, detail: `request failed: ${e.message}` };
    }
    results.push({ id: item.id, ...verdict, answer, ms: Date.now() - started });
    console.log(`${verdict.ok ? "ok  " : "FAIL"}  ${item.id}  ${verdict.detail}`);
  }
  const ms = Date.now() - t0;
  const date = new Date().toISOString().slice(0, 10);
  const slug = model.replace(/[^\w.-]+/g, "_");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `real-hebrew-${date}-${slug}.md`), formatHebrewSmokeReport(results, { model, url, date, ms, digest }));
  writeFileSync(join(out, `real-hebrew-${date}-${slug}.json`), JSON.stringify({ model, url, date, ms, digest, results }, null, 2));
  console.log(`real-model: Hebrew smoke ${results.filter((x) => x.ok).length}/${results.length} — ${(ms / 1000).toFixed(1)} s`);
  return results.every((x) => x.ok) ? 0 : 1;
}

const tags = await ensureOllama();
await ensureModel(tags);
const digest = await checkDigest();
if (hebrewSmoke) {
  const status = await hebrewSmokeRun(digest);
  if (server) server.kill();
  process.exit(status);
}
const t0 = Date.now();
const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.eval.config.ts", "--reporter", "dot", "src/agents/eval/real.eval.ts"], {
  stdio: "inherit",
  env: { ...process.env, LUMEN_REAL_MODEL: model, LUMEN_REAL_OLLAMA_URL: url, LUMEN_EVAL_OUT: out, LUMEN_REAL_MODEL_DIGEST_SEEN: digest },
  shell: process.platform === "win32",
});
console.log(`real-model: ${model} — ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (server) server.kill();
process.exit(r.status ?? 1);
