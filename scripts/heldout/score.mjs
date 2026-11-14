/**
 * Scoring the held-out sets (plan W6.17). Every function returns aggregate
 * numbers only; no item text, prompt or model answer leaves this file.
 *
 * Ollama sets (qa-he, xling, grammar-he, toolcall-he) run per model through
 * /api/chat at temperature 0. asr-he runs each dictation path the app has
 * (plan W6.19) on the same clips, written to a temporary folder outside the
 * repo: the streaming Zipformer (scripts/asr/eval.mjs, the phone), ivrit.ai
 * turbo as the browser runs it (scripts/asr/web-eval.mjs, W4.13) and
 * whisper.cpp with the turbo ggml (scripts/whisper-desktop.mjs, W1.17, the
 * desktop). Each prints numbers only, never a transcript. ocr-he renders its lines in Chromium and reads them with the
 * app's tesseract.js pipeline (scripts/heldout/ocr.mjs). Both folders are
 * deleted when the set is scored.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { callFromMessage, mcqLetter, prf, qaScore, round, toolCallScore, yesNo } from "../lib/heldout.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** One chat turn: the reply message, or { error } (never thrown, never printed). */
export async function chat(url, model, messages, extra = {}) {
  try {
    const r = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0, seed: 7, num_predict: 256 }, ...extra }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return j.message ?? { error: "no message" };
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timeout" : "request failed" };
  }
}

const options = (side) => side.options.map((o, i) => `${"ABCD"[i]}. ${o}`).join("\n");

export async function scoreQa(items, { url, model }) {
  let correct = 0;
  let f1 = 0;
  let errors = 0;
  for (const it of items) {
    const m = await chat(url, model, [
      { role: "system", content: "ענה על השאלה בעברית ובקצרה: רק התשובה עצמה, בלי הסבר." },
      { role: "user", content: it.question },
    ]);
    if (m.error) errors++;
    const s = qaScore(m.content ?? "", it.answers);
    if (s.correct) correct++;
    f1 += s.f1;
  }
  return { n: items.length, correct, share: round(correct / items.length), f1: round(f1 / items.length), errors };
}

export async function scoreXling(items, { url, model }) {
  const sys = { role: "system", content: "Answer with the letter of the correct option only: A, B, C or D." };
  const ask = async (q, opts, cue) => mcqLetter((await chat(url, model, [sys, { role: "user", content: `${q}\n${opts}\n${cue}` }])).content);
  let he = 0;
  let en = 0;
  let mixed = 0;
  for (const it of items) {
    if ((await ask(it.he.question, options(it.he), "תשובה:")) === it.answer) he++;
    if ((await ask(it.en.question, options(it.en), "Answer:")) === it.answer) en++;
    if ((await ask(it.he.question, options(it.en), "תשובה:")) === it.answer) mixed++;
  }
  const n = items.length;
  return { n, accHe: round(he / n), accEn: round(en / n), accMixed: round(mixed / n), gapHeEn: round((he - en) / n), share: round(he / n) };
}

export async function scoreGrammarModel(items, { url, model }) {
  const pairs = [];
  for (const it of items) {
    const m = await chat(url, model, [
      { role: "system", content: "אתה בודק לשון. האם יש במשפט הבא שגיאת כתיב או דקדוק? ענה במילה אחת: 'כן' או 'לא'." },
      { role: "user", content: it.text },
    ]);
    pairs.push({ pred: yesNo(m.content ?? ""), gold: it.flawed });
  }
  const r = prf(pairs);
  return { ...r, share: r.f1 };
}

/** The app's own checker (plan W5.3), where the branch has it: any finding = "has an error". */
export async function scoreGrammarChecker(items) {
  const file = join(ROOT, "src/ai/hebrewGrammar.ts");
  if (!existsSync(file)) return { status: "unavailable", reason: "src/ai/hebrewGrammar.ts is not on this branch (plan W5.3)" };
  const { tsImport } = await import("tsx/esm/api");
  const { hebrewGrammar } = await tsImport(file, import.meta.url);
  const r = prf(items.map((it) => ({ pred: hebrewGrammar(it.text).length > 0, gold: it.flawed })));
  return { ...r, share: r.f1 };
}

export async function scoreToolcalls(items, { url, model }) {
  let valid = 0;
  let intent = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let errors = 0;
  for (const it of items) {
    const tools = it.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.name.replace(/_/g, " "),
        parameters: { type: "object", properties: Object.fromEntries(t.params.map((p) => [p, { type: "string", description: p.replace(/_/g, " ") }])), required: [] },
      },
    }));
    const m = await chat(url, model, [
      { role: "system", content: "You are the voice assistant of a Hebrew speaker. Call exactly one of the tools to do what the request asks. Fill each argument with the exact words of the request, and leave out arguments the request does not mention." },
      { role: "user", content: it.text },
    ], { tools });
    if (m.error) errors++;
    const s = toolCallScore(callFromMessage(m), { intent: it.intent, slots: it.slots }, it.tools);
    if (s.valid) valid++;
    if (s.intent) intent++;
    tp += s.slotTp;
    fp += s.slotFp;
    fn += s.slotFn;
  }
  const n = items.length;
  const p = tp + fp ? tp / (tp + fp) : 0;
  const r = tp + fn ? tp / (tp + fn) : 0;
  return { n, valid: round(valid / n), intent: round(intent / n), slotF1: round(p + r ? (2 * p * r) / (p + r) : 0), share: round(valid / n), errors };
}

/** A temporary folder outside the repo, removed by the caller. */
export function scratch(prefix) {
  const dir = mkdtempSync(join(process.env.LUMEN_HELDOUT_TMP ?? tmpdir(), prefix));
  if (resolve(dir).startsWith(ROOT + "/")) throw new Error("the scratch folder must be outside the repo");
  return dir;
}

/** The dictation paths asr-he scores (plan W6.19), and the target each is held to. */
export const ASR_ENGINES = {
  zipformer: { path: "phone and browser, live (Zipformer2 streaming, WASM)", target: 0.15, script: "scripts/asr/eval.mjs" },
  "whisper-web": { path: "browser (ivrit.ai turbo ONNX q4f16, as transformers.js runs it)", target: 0.15, script: "scripts/asr/web-eval.mjs" },
  "whisper-cpp": { path: "desktop (whisper.cpp, ivrit.ai turbo ggml)", target: 0.1, script: "scripts/whisper-desktop.mjs" },
};

const pick4 = (x) => (typeof x === "number" ? round(x) : null);

/**
 * Run one dictation path over the clips in `dir` (fleurs.json + audio, as
 * fetch.py writes them). Returns aggregates, or { status, reason }. The
 * script paths can be replaced (tests run fakes).
 */
/** Why `engine` cannot run here (null: it can), checked before any clip is fetched. */
export function asrEngineMissing(engine, ctx = {}) {
  const meta = ASR_ENGINES[engine];
  if (!meta) return `unknown engine ${engine}`;
  if (!existsSync(ctx.scripts?.[engine] ?? join(ROOT, meta.script))) return `${meta.script} is not on this branch`;
  if (engine === "zipformer" && (!ctx.asrModel || !existsSync(join(ctx.asrModel, "tokens.txt")))) return "no ASR model (--asr-model: the folder scripts/asr/fetch-model.sh fills)";
  if (engine === "whisper-cpp" && (!ctx.whisperGgml || !existsSync(ctx.whisperGgml))) return "no whisper.cpp model (--whisper-ggml: the ivrit.ai turbo ggml file)";
  return null;
}

export function scoreAsrEngine(engine, dir, ctx = {}) {
  const meta = ASR_ENGINES[engine];
  const missing = asrEngineMissing(engine, ctx);
  if (missing) return { status: "unavailable", reason: missing };
  const script = ctx.scripts?.[engine] ?? join(ROOT, meta.script);
  const out = join(dir, `scores-${engine}.json`);
  const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
  let args;
  if (engine === "zipformer") {
    env.LUMEN_ASR_MODEL_DIR = ctx.asrModel;
    args = ["--split", `heldout=${dir}`, "--out", out];
  } else if (engine === "whisper-web") {
    // Ozen v1 is not measured: it stays off until its licence is approved (plan W6.19).
    args = ["--fleurs", dir, "--models", "turbo", "--out", out];
  } else {
    args = ["wer", "--split", `heldout=${dir}`, "--model", ctx.whisperGgml, "--cli", ctx.whisperCli ?? "whisper-cli", "--out", out];
  }
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", maxBuffer: 1 << 24 });
  if (!existsSync(out)) return { status: "error", reason: `${meta.script} exited ${r.status}` };
  const j = JSON.parse(readFileSync(out, "utf8"));
  // web-eval keys its split by the folder's role ("fleurs-validation"); the others by the name given.
  const s = j.splits?.heldout ?? j.splits?.["fleurs-validation"] ?? null;
  if (!s || s.status) return { status: "error", reason: `${meta.script}: no score for the clips${s?.status ? ` (${s.status})` : ""}` };
  return {
    wer: pick4(s.wer),
    cer: pick4(s.cer),
    ...(typeof s["wer.v2"] === "number" ? { werV2: pick4(s["wer.v2"]) } : {}),
    p95Ms: s["latency.p95Ms"] ?? s.p95Ms ?? null,
    ...(typeof s.rtf === "number" ? { rtf: s.rtf } : {}),
    target: meta.target,
    met: typeof s.wer === "number" ? s.wer <= meta.target : null,
  };
}

/**
 * asr-he: the clips are fetched from the pinned FLEURS revision into a
 * scratch folder once, scored by every dictation path asked for, and deleted.
 * `engine` (the Zipformer's numbers) stays for older readers of the report.
 */
export function scoreAsr(items, { revision, canary, asrModel, whisperGgml, whisperCli, engines = ["zipformer", "whisper-cpp"], scripts, clipsDir }) {
  const ctx = { asrModel, whisperGgml, whisperCli, scripts };
  // Nothing to run: say why, without fetching a clip.
  if (engines.every((e) => asrEngineMissing(e, ctx))) {
    const per = Object.fromEntries(engines.map((e) => [e, { status: "unavailable", reason: asrEngineMissing(e, ctx) }]));
    return { n: items.length, status: "unavailable", reason: per.zipformer?.reason ?? Object.values(per)[0]?.reason ?? "no engine asked", engines: per };
  }
  const dir = clipsDir ?? scratch("lumen-heldout-asr-");
  try {
    if (!clipsDir) {
      const py = spawnSync("python3", ["-I", join(ROOT, "scripts/heldout/fetch.py"), "fleurs-audio", "--revision", revision, "--out", dir, "--canary", canary], { input: JSON.stringify(items), encoding: "utf8", stdio: ["pipe", "ignore", "pipe"], maxBuffer: 1 << 26 });
      if (py.status !== 0) return { status: "error", reason: `fetch.py fleurs-audio exited ${py.status}` };
    }
    const per = {};
    for (const e of engines) per[e] = scoreAsrEngine(e, dir, ctx);
    const z = per.zipformer;
    const head = z && !z.status ? { wer: z.wer, cer: z.cer, p95Ms: z.p95Ms } : { status: z?.status ?? "unavailable", reason: z?.reason ?? "not asked" };
    return { n: items.length, ...head, engines: per };
  } finally {
    if (!clipsDir) rmSync(dir, { recursive: true, force: true });
  }
}

/** ocr-he: rendered and read in a scratch folder (scripts/heldout/ocr.mjs). */
export async function scoreOcr(items, { fonts, canary, cache }) {
  if (!fonts?.length) return { status: "unavailable", reason: "the bundle pins no fonts (built without network to npm)" };
  const dir = scratch("lumen-heldout-ocr-");
  try {
    const { renderAndRead } = await import("./ocr.mjs");
    return await renderAndRead(items, { fonts, canary, cache, dir });
  } catch (e) {
    return { status: "error", reason: String(e?.message ?? e).slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

