/**
 * The "real models day" (plan W4.6): every real-model eval the plan owes, as
 * one list of steps that `npm run models:day` runs in order on Tal's machine
 * (Ollama, a GPU, WebGPU in Chromium). This file is the pure part — the
 * steps, what each one needs, the install checklist, resume state, the
 * metrics read back from each eval's own files, and the receipt — so it can
 * be tested without a model. scripts/models-day.mjs is the CLI around it.
 *
 * A step whose script is not on the checked-out branch is "unavailable"
 * (with the PR that brings it), never a failure: the command runs on any
 * branch and gets fuller as PRs merge.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Ollama ≥ 0.5 answers `format` with a JSON schema (structured outputs), which W4.31 relies on. */
export const MIN_OLLAMA = "0.5.0";

/** Exact Ollama tags, with the download size Ollama's library lists (GB, q4 unless noted). */
export const MODELS = {
  "gemma3:12b": { gb: 8.1, why: "agent eval, quality tier (plan 7.9: ≥ 90 %)" },
  "qwen2.5:7b": { gb: 4.7, why: "agent eval, balanced tier (plan 7.9: ≥ 80 %), PDF chat, summaries, canvas, literature review" },
  "qwen2.5-coder:1.5b": { gb: 1.0, why: "autocomplete (FIM) latency, plan 6.9" },
  "qwen3:0.6b": { gb: 0.5, why: "the tiny real model of plan 7.2" },
  "nomic-embed-text": { gb: 0.3, why: "local embeddings for PDF chat (plan 6.8)" },
  "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF": { gb: 1.3, why: "DictaLM 3.0 1.7B (plan W2.4), optional step" },
  "qwen3:4b": { gb: 2.6, why: "what DictaLM 1.7B is compared with (plan W2.4), optional step" },
};

/**
 * Each step: `requires` is the npm script (or file) that must exist on the
 * branch; `providedBy` names the PR that brings it when it is missing;
 * `models` are pulled first; `needs` are tools checked before the run;
 * `minutes` is the declared estimate on a 12 GB GPU; `optional` steps run
 * only with --with <id>. `commands(ctx)` returns what to run, in order.
 */
export const STEPS = [
  {
    id: "agents-gemma3",
    title: "Agent eval — gemma3:12b (every agent, tools on the eval vault)",
    plan: ["7.9", "7.3", "5.3", "4.11", "15.3"],
    requires: { script: "eval:agents" },
    models: ["gemma3:12b"],
    minutes: 30,
    target: { metric: "share", min: 0.9, text: "≥ 90 % of cases (plan 7.9)" },
    commands: (c) => [npm("eval:agents", ["--model", "gemma3:12b", "--url", c.url, "--out", c.dir])],
    parse: (dir) => agentsMetrics(dir),
  },
  {
    id: "agents-qwen",
    title: "Agent eval — qwen2.5:7b",
    plan: ["7.9", "7.3", "5.3", "4.11", "15.3"],
    requires: { script: "eval:agents" },
    models: ["qwen2.5:7b"],
    minutes: 20,
    target: { metric: "share", min: 0.8, text: "≥ 80 % of cases (plan 7.9)" },
    commands: (c) => [npm("eval:agents", ["--model", "qwen2.5:7b", "--url", c.url, "--out", c.dir])],
    parse: (dir) => agentsMetrics(dir),
  },
  {
    id: "pdf-chat",
    title: "PDF chat — answers cited to the right page",
    plan: ["6.8", "15.17"],
    requires: { script: "eval:pdf-chat" },
    models: ["qwen2.5:7b", "nomic-embed-text"],
    minutes: 8,
    target: { metric: "share", min: 0.85, text: "≥ 85 % correctly cited (plan 6.8)" },
    commands: (c) => [npm("eval:pdf-chat", [], evalEnv(c, "qwen2.5:7b"))],
    parse: (dir) => pdfChatMetrics(dir),
  },
  {
    id: "summarize",
    title: "Local summaries — every sentence grounded in the source",
    plan: ["6.11"],
    requires: { script: "eval:summarize" },
    models: ["qwen2.5:7b"],
    minutes: 8,
    target: { metric: "share", min: 0.95, text: "≥ 95 % grounded (plan 6.11)" },
    commands: (c) => [npm("eval:summarize", [], evalEnv(c, "qwen2.5:7b"))],
    parse: (dir) => shareFrom(dir, /^summary-.*\.json$/, "grounded", "produced"),
  },
  {
    id: "fim",
    title: "Autocomplete (FIM) latency",
    plan: ["6.9", "15.17"],
    requires: { script: "bench:fim" },
    models: ["qwen2.5-coder:1.5b"],
    minutes: 3,
    target: { metric: "p50Ms", max: 300, text: "p50 < 300 ms (plan 6.9)" },
    commands: (c) => [npm("bench:fim", ["--url", c.url, "--model", "qwen2.5-coder:1.5b", "--assert", "300", "--json", join(c.dir, "fim.json")])],
    parse: (dir) => fimMetrics(dir),
  },
  {
    id: "real-tiny",
    title: "Every agent once on the tiny real model",
    plan: ["7.2"],
    requires: { script: "ci:real-model" },
    models: ["qwen3:0.6b"],
    minutes: 4,
    commands: (c) => [npm("ci:real-model", ["--model", "qwen3:0.6b", "--url", c.url, "--out", c.dir], { LUMEN_REAL_MODEL_REQUIRED: "1" })],
    parse: (dir) => realMetrics(dir),
  },
  {
    id: "rerank",
    title: "Reranker on HeQ (bge-reranker, transformers.js)",
    plan: ["7.6"],
    requires: { script: "eval:rerank" },
    models: [],
    needs: ["network"],
    minutes: 10,
    commands: (c) => [npm("eval:rerank", [], { LUMEN_EVAL_OUT: c.dir })],
    parse: (dir) => pick(dir, /^rerank-.*\.json$/, ["gain", "decision"]),
  },
  {
    id: "asr-zipformer",
    title: "Live dictation WER — Zipformer2 streaming on FLEURS-he validation",
    plan: ["6.1", "15.3", "W4.13"],
    requires: { file: "scripts/asr/eval.mjs" },
    models: [],
    needs: ["python3", "ffmpeg", "network"],
    minutes: 12,
    target: { metric: "wer", max: 0.15, text: "WER ≤ 15 % on FLEURS-he validation (plan W4.13; 23.6 % in CI)" },
    commands: (c) => {
      const model = join(c.cache, "zipformer2-66m-streaming-he");
      const fleurs = join(c.cache, "fleurs-validation");
      return [
        { cmd: "bash", args: ["scripts/asr/fetch-model.sh", model] },
        { cmd: "python3", args: ["-I", "scripts/asr/fleurs_spike.py", "--out", fleurs, "--n", "30"], skipIf: () => existsSync(join(fleurs, "fleurs.json")) },
        { cmd: "node", args: ["scripts/asr/eval.mjs", "--split", "dev=eval/golden/asr-he/dev", "--split", `fleurs-validation=${fleurs}`, "--out", join(c.dir, "asr-scores.json")], env: { LUMEN_ASR_MODEL_DIR: model } },
      ];
    },
    parse: (dir) => asrMetrics(join(dir, "asr-scores.json"), "fleurs-validation"),
  },
  {
    id: "asr-web",
    title: "Dictation WER in the browser — Whisper (ivrit.ai) on WebGPU / WASM",
    plan: ["W4.13", "1.3", "W5.13", "15.3"],
    requires: { script: "eval:asr-web" },
    providedBy: "plan W4.13 (lane A, after this PR)",
    models: [],
    needs: ["chromium", "network"],
    minutes: 20,
    target: { metric: "wer", max: 0.15, text: "WER ≤ 15 % on FLEURS-he validation, p95 ≤ 2 s (plan W4.13)" },
    commands: (c) => [npm("eval:asr-web", ["--fleurs", join(c.cache, "fleurs-validation"), "--out", join(c.dir, "asr-web.json")])],
    parse: (dir) => asrMetrics(join(dir, "asr-web.json"), "fleurs-validation"),
  },
  {
    id: "tool-calls",
    title: "Tool-call reliability — 200 Hebrew and English calls per model",
    plan: ["W4.31", "5.3"],
    requires: { script: "eval:tool-calls" },
    providedBy: "plan W4.31 (lane A, after this PR)",
    models: ["qwen2.5:7b", "gemma3:12b"],
    minutes: 15,
    target: { metric: "share", min: 0.95, text: "≥ 95 % valid calls on both models (plan W4.31)" },
    commands: (c) => [npm("eval:tool-calls", ["--models", "qwen2.5:7b,gemma3:12b", "--url", c.url, "--out", c.dir])],
    parse: (dir) => toolCallMetrics(dir),
  },
  {
    id: "meetings",
    title: "Meeting notes — tasks found in the owner's recordings",
    plan: ["6.16"],
    requires: { script: "eval:meetings" },
    models: ["qwen2.5:7b"],
    minutes: 5,
    blockedUnless: { option: "meetingsDir", reason: "needs --meetings-dir <bundle>/meetings/owner (the recordings of owner item 15.11)" },
    commands: (c) => [npm("eval:meetings", [], { ...evalEnv(c, "qwen2.5:7b"), LUMEN_EVAL_MEETINGS_DIR: c.meetingsDir })],
    parse: (dir) => ({ files: listFiles(dir).length }),
  },
  {
    id: "bench-models",
    title: "Every browser engine in real Chromium (WebGPU): load, p50/p95, memory, quality",
    plan: ["7.8", "15.14"],
    requires: { script: "bench:models" },
    providedBy: "#421 feat/model-bench",
    models: [],
    needs: ["chromium", "network"],
    minutes: 25,
    commands: (c) => [npm("bench:models", ["--out", join(c.dir, "bench-models.json")])],
    parse: (dir) => benchMetrics(join(dir, "bench-models.json")),
  },
  {
    id: "canvas-draw",
    title: "Canvas \"draw me\" — Mermaid from a local model",
    plan: ["W2.18"],
    requires: { script: "eval:canvas-draw" },
    providedBy: "#404 feat/canvas-mermaid",
    models: ["qwen2.5:7b"],
    minutes: 5,
    commands: (c) => [npm("eval:canvas-draw", ["--model", "qwen2.5:7b", "--url", c.url, "--out", c.dir])],
    parse: (dir) => ({ files: listFiles(dir).length }),
  },
  {
    id: "crosslingual",
    title: "Cross-language search — nDCG@10 of multilingual-e5",
    plan: ["W5.28"],
    requires: { script: "eval:crosslingual" },
    providedBy: "#434 feat/crosslingual-search",
    models: [],
    needs: ["network"],
    minutes: 5,
    commands: (c) => [npm("eval:crosslingual", [], { LUMEN_EVAL_OUT: c.dir })],
    parse: (dir) => ({ files: listFiles(dir).length }),
  },
  {
    id: "lit-review",
    title: "Literature-review matrix — fields with a citation on the right page",
    plan: ["W5.12"],
    requires: { script: "eval:lit-review" },
    providedBy: "#438 feat/lit-review-matrix",
    models: ["qwen2.5:7b"],
    minutes: 5,
    commands: (c) => [npm("eval:lit-review", [], evalEnv(c, "qwen2.5:7b"))],
    parse: (dir) => ({ files: listFiles(dir).length }),
  },
  {
    id: "dictalm3",
    title: "DictaLM 3.0 1.7B against qwen3:4b, then the default decision",
    plan: ["W2.4"],
    requires: { script: "dictalm3" },
    providedBy: "#379 feat/dictalm3",
    models: ["hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF", "qwen3:4b"],
    minutes: 15,
    optional: true,
    commands: (c) => [
      npm("dictalm3", ["eval", "--size", "1.7B", "--url", c.url], { LUMEN_EVAL_OUT: c.dir }),
      npm("dictalm3", ["decide", "--json", join(c.dir, "dictalm3-decision.json")], { LUMEN_EVAL_OUT: c.dir }),
    ],
    parse: (dir) => ({ files: listFiles(dir).length }),
  },
];

/**
 * Every AI task whose status rests on a mock or waits for a real model (plan
 * statuses with ✅*, dodMock or "real model"), and either the step that
 * measures it here or why this command cannot (plan W4.6 acceptance 2).
 */
export const COVERAGE = [
  ["1.3", "asr-web", "offline dictation was checked against a mocked Whisper"],
  ["2.7", null, "the injection guard is rule-based; what is owed is the official golden set + 30 Hebrew attacks (owner 15.11), not a model run"],
  ["4.11", "agents-gemma3", "the formulator agent is one of the eval's agents"],
  ["5.3", "agents-gemma3", "15/15 against the fake Ollama; tool-call validity also in tool-calls"],
  ["5.7", null, "the model manager's pull is the same /api/pull this command uses for its models; the UI itself is a hand check"],
  ["6.0", null, "the conversion pipeline's proof run is owner 15.9 (model conversion), not an eval"],
  ["6.1", "asr-zipformer", "WER 23.6 % in CI on WASM"],
  ["6.8", "pdf-chat", "BM25-only dev result so far"],
  ["6.9", "fim", "latency needs a real Ollama"],
  ["6.11", "summarize", "95 % target never measured"],
  ["6.16", "meetings", "needs the owner's recordings (15.11)"],
  ["7.2", "real-tiny", "never ran outside the fake"],
  ["7.3", "agents-gemma3", "every agent; HTML report"],
  ["7.6", "rerank", "dev split only"],
  ["7.8", "bench-models", "refuses SwiftShader; needs a real GPU"],
  ["7.9", "agents-qwen", "processing this report is 7.9"],
  ["W1.17", null, "desktop whisper.cpp: needs whisper-cli and a pinned ggml file — `npm run whisper:desktop -- wer` from #383, a separate desktop check"],
  ["W2.1", null, "owed: the owner's rating of 50 suggestions; the 1,000-note run is not scripted yet"],
  ["W2.4", "dictalm3", "optional: blocked while the variant's owner checks are open"],
  ["W2.5", null, "DictaBERT-char-menaked needs the owner's ONNX export first (scripts/models/export-menaked.py)"],
  ["W2.7", null, "pyannote ONNX must be pinned first"],
  ["W2.14", null, "owed: three real sites by hand on qwen2.5:3b"],
  ["W2.18", "canvas-draw", "golden 21/21 with real Mermaid; the model part is owed"],
  ["W4.13", "asr-web", "the browser Whisper path"],
  ["W4.31", "tool-calls", "200 calls per model"],
  ["W5.3", null, "rule-based checker; owed is a held-out set of 200 real sentences (owner), the optional model is not required"],
  ["W5.12", "lit-review", "dev probe only; 20 gold papers are the owner's"],
  ["W5.13", "asr-web", "Whisper on WebGPU; the 90-minute lecture timing is a hand check"],
  ["W5.28", "crosslingual", "e5 nDCG never measured"],
].map(([task, step, note]) => ({ task, step, note }));

// ── helpers that build commands ───────────────────────────────────────────

function npm(script, args, env = {}) {
  return { cmd: "npm", args: ["run", script, ...(args.length ? ["--", ...args] : [])], env };
}
function evalEnv(c, model) {
  return { LUMEN_EVAL_MODEL: model, LUMEN_EVAL_OLLAMA_URL: c.url, LUMEN_EVAL_OUT: c.dir };
}

// ── availability, plan, checklist ─────────────────────────────────────────

/** Whether a step can run on this checkout: { ok, reason }. */
export function availability(step, { scripts, root = ".", options = {} }) {
  const r = step.requires;
  if (r.script && !(r.script in scripts)) return { ok: false, status: "unavailable", reason: `\`npm run ${r.script}\` is not on this branch${step.providedBy ? ` — it comes with ${step.providedBy}` : ""}` };
  if (r.file && !existsSync(join(root, r.file))) return { ok: false, status: "unavailable", reason: `${r.file} is not on this branch${step.providedBy ? ` — it comes with ${step.providedBy}` : ""}` };
  if (step.blockedUnless && !options[step.blockedUnless.option]) return { ok: false, status: "blocked", reason: step.blockedUnless.reason };
  return { ok: true };
}

/** The steps this run covers, in order, after --only / --skip / --with. */
export function selectSteps(steps, { only = [], skip = [], withOptional = [] } = {}) {
  return steps.filter((s) => (only.length ? only.includes(s.id) : !s.optional || withOptional.includes(s.id)) && !skip.includes(s.id));
}

/** Compare dotted versions: -1, 0, 1. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const hasModel = (installed, tag) => installed.includes(tag) || installed.includes(`${tag}:latest`);

/**
 * What Tal must install before the run, as lines to print: each tool with
 * its install command, each model with `ollama pull <exact tag>` and its
 * size. `env` is what the preflight found.
 */
export function checklist(steps, env) {
  const runnable = steps.filter((s) => s.available?.ok !== false);
  const models = [...new Set(runnable.flatMap((s) => s.models))];
  const needs = new Set(runnable.flatMap((s) => s.needs ?? []));
  const items = [];
  const item = (ok, text, fix) => items.push({ ok, text, fix });
  item(compareVersions(env.node ?? "0", "22.6.0") >= 0, `Node ≥ 22.6 (found ${env.node ?? "none"})`, "https://nodejs.org (LTS), then `npm ci` in the repo");
  item(!!env.nodeModules, "node_modules installed", "npm ci");
  const ollamaOk = !!env.ollama && compareVersions(env.ollama.version, MIN_OLLAMA) >= 0;
  item(ollamaOk, `Ollama ≥ ${MIN_OLLAMA} running at ${env.url} (found ${env.ollama ? env.ollama.version + (env.ollama.fake ? ", the FAKE server" : "") : "nothing"})`, "https://ollama.com/download, then `ollama serve`");
  item(!!env.gpu, `GPU (found ${env.gpu ?? "none"})`, "a 12 GB GPU or Apple Silicon with ≥ 16 GB; on CPU the run takes many hours");
  if (needs.has("python3")) item(!!env.tools?.python3, "Python 3 with huggingface_hub and pyarrow (FLEURS clips)", "python3 -m pip install -r scripts/golden/requirements.txt");
  if (needs.has("ffmpeg")) item(!!env.tools?.ffmpeg, "ffmpeg", "brew install ffmpeg  (or apt-get install ffmpeg)");
  if (needs.has("chromium")) item(!!env.tools?.chromium, "Playwright Chromium (WebGPU)", "npx playwright install chromium");
  if (needs.has("network")) item(true, "Network to huggingface.co for the first download of browser models", "");
  const installed = env.ollama?.models ?? [];
  let gb = 0;
  for (const tag of models) {
    const have = hasModel(installed, tag);
    if (!have) gb += MODELS[tag]?.gb ?? 0;
    item(have, `model ${tag}${MODELS[tag] ? ` (${MODELS[tag].gb} GB) — ${MODELS[tag].why}` : ""}`, `ollama pull ${tag}`);
  }
  item((env.diskFreeGB ?? Infinity) >= gb + 5, `disk: ${gb.toFixed(1)} GB of models to pull + 5 GB working space (free: ${env.diskFreeGB ?? "?"} GB)`, "free some disk space");
  return items;
}

/** The declared time of the selected runnable steps (minutes). */
export function declaredMinutes(steps) {
  return steps.filter((s) => s.available?.ok !== false).reduce((n, s) => n + s.minutes, 0);
}

// ── resume state ──────────────────────────────────────────────────────────

/**
 * Which steps still have to run: a step with a finished record ("pass",
 * "fail") is kept unless it is in `redo`; "running" (the run was killed)
 * and "interrupted" run again.
 */
export function pendingSteps(steps, state, redo = []) {
  return steps.filter((s) => {
    const r = state.steps?.[s.id];
    if (redo.includes(s.id)) return true;
    return !r || !["pass", "fail", "unavailable", "blocked"].includes(r.status);
  });
}

/** pass / fail of a finished step from its exit code and its target. */
export function judge(step, exitCode, metrics) {
  if (exitCode !== 0) return "fail";
  const t = step.target;
  if (!t || !metrics || metrics[t.metric] === undefined || metrics[t.metric] === null) return "pass";
  const v = metrics[t.metric];
  if (t.min !== undefined && v < t.min) return "fail";
  if (t.max !== undefined && v > t.max) return "fail";
  return "pass";
}

// ── metrics read back from each eval's own files ──────────────────────────

export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function newest(dir, re) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort() : [];
  return files.length ? readJson(join(dir, files[files.length - 1])) : null;
}

/** Per-agent pass counts of an agents-*.json (src/agents/eval/live.eval.ts). */
export function agentsMetrics(dir) {
  const j = newest(dir, /^agents-.*\.json$/);
  if (!j) return null;
  const isPass = (r) => r.status !== "skipped" && !r.error && (r.checks ?? []).every((c) => c.ok);
  const ran = (j.results ?? []).filter((r) => r.status !== "skipped");
  const byAgent = {};
  for (const r of ran) {
    const a = (byAgent[r.agent] ??= { passed: 0, total: 0 });
    a.total++;
    if (isPass(r)) a.passed++;
  }
  const passed = ran.filter(isPass).length;
  const prompts = newest(dir, /^prompts-.*\.json$/);
  const pr = prompts?.results ?? [];
  return {
    kind: j.kind ?? "model",
    model: j.model,
    passed,
    total: ran.length,
    share: ran.length ? passed / ran.length : 0,
    agents: Object.keys(byAgent).length,
    byAgent,
    ...(pr.length ? { prompts: { passed: pr.filter((r) => r.ok ?? r.pass ?? (r.checks ?? []).every((c) => c.ok)).length, total: pr.length } } : {}),
  };
}

/** nDCG@k of a ranked list of cited pages against the pages that hold the answer (binary relevance). */
export function ndcgAt(ranked, relevant, k = 5) {
  const rel = new Set(relevant);
  const seen = new Set();
  let dcg = 0;
  ranked.slice(0, k).forEach((p, i) => {
    if (rel.has(p) && !seen.has(p)) dcg += 1 / Math.log2(i + 2);
    seen.add(p);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(k, rel.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

export function pdfChatMetrics(dir) {
  const j = newest(dir, /^pdf-chat-.*\.json$/);
  if (!j) return null;
  const rows = j.rows ?? [];
  const scored = rows.filter((r) => (r.answerPages ?? []).length);
  const ndcg = scored.length ? scored.reduce((n, r) => n + ndcgAt(r.pages ?? [], r.answerPages, 5), 0) / scored.length : null;
  return { passed: j.passed, total: j.total, share: j.total ? j.passed / j.total : 0, citationNdcg5: ndcg === null ? null : round(ndcg, 4) };
}

function shareFrom(dir, re, num, den) {
  const j = newest(dir, re);
  if (!j) return null;
  return { [num]: j[num], [den]: j[den], share: j[den] ? j[num] / j[den] : 0 };
}

function pick(dir, re, keys) {
  const j = newest(dir, re);
  if (!j) return null;
  return Object.fromEntries(keys.map((k) => [k, j[k]]));
}

export function fimMetrics(dir) {
  const j = readJson(join(dir, "fim.json"));
  return j ? { model: j.model, requests: j.requests, p50Ms: j.p50Ms, p95Ms: j.p95Ms, emptyCompletions: j.emptyCompletions } : null;
}

export function realMetrics(dir) {
  const j = newest(dir, /^real-.*\.json$/);
  if (!j) return null;
  const rs = j.results ?? [];
  const ok = rs.filter((r) => r.ok ?? (r.checks ?? []).every((c) => c.ok)).length;
  return { passed: ok, total: rs.length, share: rs.length ? ok / rs.length : 0 };
}

/** WER of one split of an asr-scores.json (scripts/asr/eval.mjs). */
export function asrMetrics(file, split) {
  const j = readJson(file);
  if (!j) return null;
  const s = j.splits?.[split] ?? null;
  const dev = j.splits?.dev ?? null;
  return { engine: j.engine, wer: s?.wer ?? null, cer: s?.cer ?? null, p95Ms: s?.["latency.p95Ms"] ?? s?.p95Ms ?? null, devWer: dev?.wer ?? null, modelLoadMs: j.modelLoadMs ?? null };
}

export function toolCallMetrics(dir) {
  const j = newest(dir, /^tool-calls-.*\.json$/);
  if (!j) return null;
  const models = j.models ?? {};
  const shares = Object.values(models).map((m) => m.share ?? 0);
  return { share: shares.length ? Math.min(...shares) : 0, models };
}

export function benchMetrics(file) {
  const j = readJson(file);
  if (!j) return null;
  const rows = Array.isArray(j) ? j : (j.rows ?? []);
  return { engines: rows.length, measured: rows.filter((r) => r.status === "measured").length, errors: rows.filter((r) => r.status === "error").length };
}

const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

// ── receipt ───────────────────────────────────────────────────────────────

/** JSON with sorted keys, so the same report always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Every file a step wrote, with its size and sha256, relative to `base`. */
export function artifacts(dir, base) {
  return listFiles(dir).map((p) => {
    const data = readFileSync(p);
    return { path: relative(base, p).split("\\").join("/"), bytes: data.length, sha256: sha256(data) };
  });
}

/**
 * Seal a report: `receipt.digest` is the sha256 of the canonical report
 * without its receipt; with an Ed25519 private key (PEM), also a signature
 * over that digest and the public key to check it with.
 */
export function seal(report, privateKeyPem = null) {
  const { receipt: _old, ...body } = report;
  const digest = sha256(canonical(body));
  const receipt = { alg: "sha256", digest };
  if (privateKeyPem) {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("the signing key must be Ed25519 (openssl genpkey -algorithm ed25519)");
    receipt.signature = {
      alg: "ed25519",
      publicKey: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
      value: edSign(null, Buffer.from(digest, "hex"), key).toString("base64"),
    };
  }
  return { ...body, receipt };
}

/**
 * Check a sealed report against the files next to it: the digest, the
 * signature when there is one, and every artifact's sha256. Returns the list
 * of problems (empty = intact).
 */
export function verifyReport(report, base) {
  const problems = [];
  const { receipt, ...body } = report;
  if (!receipt?.digest) return ["no receipt"];
  if (sha256(canonical(body)) !== receipt.digest) problems.push("the report was changed after it was sealed (digest mismatch)");
  if (receipt.signature) {
    try {
      const ok = edVerify(null, Buffer.from(receipt.digest, "hex"), createPublicKey(receipt.signature.publicKey), Buffer.from(receipt.signature.value, "base64"));
      if (!ok) problems.push("the signature does not match the digest");
    } catch (e) {
      problems.push(`the signature cannot be checked: ${e.message}`);
    }
  }
  for (const s of body.steps ?? []) {
    for (const a of s.artifacts ?? []) {
      const p = join(base, a.path);
      if (!existsSync(p)) problems.push(`${a.path}: missing`);
      else if (sha256(readFileSync(p)) !== a.sha256) problems.push(`${a.path}: changed after the run`);
    }
  }
  return problems;
}

// ── the report ────────────────────────────────────────────────────────────

const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)} %`);

function headline(s) {
  const m = s.metrics;
  if (!m) return s.reason ?? (s.exit ? `exit ${s.exit} — see ${s.id}/log.txt` : "");
  if (m.byAgent) return `${m.passed}/${m.total} cases (${pct(m.share)}), ${m.agents} agents`;
  if (m.p50Ms !== undefined && m.requests !== undefined) return `p50 ${m.p50Ms} ms, p95 ${m.p95Ms} ms (${m.requests} requests)`;
  if (m.wer !== undefined) return `WER ${pct(m.wer)}${m.devWer !== null && m.devWer !== undefined ? `, dev ${pct(m.devWer)}` : ""}`;
  if (m.citationNdcg5 !== undefined) return `${m.passed}/${m.total} cited (${pct(m.share)}), citation nDCG@5 ${m.citationNdcg5 ?? "—"}`;
  if (m.share !== undefined) return pct(m.share);
  return Object.entries(m).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
}

/** The Markdown report Tal sends back (plan 7.9 reads report.json). */
export function formatReport(report) {
  const L = [];
  L.push(`# Real models day — ${report.runId}`, "");
  if (report.kind !== "model") L.push("> **WIRING RUN — NOT A MODEL SCORE.** Ollama answered as the fake server (`lumen_fake`); every number below only proves the plumbing.", "");
  L.push(`- Commit: \`${report.git?.commit ?? "?"}\`${report.git?.dirty ? " (uncommitted changes)" : ""}`);
  L.push(`- Machine: ${report.host?.platform} ${report.host?.arch}, ${report.host?.cpus} CPUs, ${report.host?.ramGB} GB RAM, GPU: ${report.host?.gpu ?? "none found"}`);
  L.push(`- Ollama ${report.ollama?.version ?? "—"} at ${report.ollama?.url}`);
  L.push(`- Declared ${report.declaredMinutes} min; took ${report.actualMinutes ?? "—"} min of machine time`);
  L.push("", "| Step | Plan | Status | Result | Target | min |", "|---|---|---|---|---|---|");
  for (const s of report.steps) L.push(`| ${s.id} | ${s.plan.join(", ")} | ${s.status} | ${headline(s).replace(/\|/g, "\\|")} | ${s.target ?? ""} | ${s.ms !== undefined ? (s.ms / 60000).toFixed(1) : "—"} |`);
  const agents = report.steps.filter((s) => s.metrics?.byAgent);
  if (agents.length) {
    const names = [...new Set(agents.flatMap((s) => Object.keys(s.metrics.byAgent)))].sort();
    L.push("", "## Per agent", "", `| Agent | ${agents.map((s) => s.metrics.model ?? s.id).join(" | ")} |`, `|---|${agents.map(() => "---").join("|")}|`);
    for (const n of names) L.push(`| ${n} | ${agents.map((s) => (s.metrics.byAgent[n] ? `${s.metrics.byAgent[n].passed}/${s.metrics.byAgent[n].total}` : "—")).join(" | ")} |`);
  }
  L.push("", "## Plan coverage (every ✅* / dodMock AI task)", "", "| Task | Measured by | Note |", "|---|---|---|");
  for (const c of report.coverage) {
    const s = c.step ? report.steps.find((x) => x.id === c.step) : null;
    L.push(`| ${c.task} | ${c.step ? `${c.step} (${s?.status ?? "not selected"})` : "— not by this command"} | ${c.note} |`);
  }
  if (report.models && Object.keys(report.models).length) {
    L.push("", "## Models (Ollama digests)", "");
    for (const [m, d] of Object.entries(report.models)) L.push(`- ${m}: \`${d ?? "?"}\``);
  }
  L.push("", "## Receipt", "", `sha256 \`${report.receipt?.digest ?? "—"}\`${report.receipt?.signature ? " · signed (Ed25519)" : " · unsigned (pass --sign-key to sign)"}`, "", "Check it: `npm run models:day -- verify " + `eval/results/day/${report.runId}/report.json\``, "");
  return L.join("\n");
}
