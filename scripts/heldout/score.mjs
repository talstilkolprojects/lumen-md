/**
 * Scoring the held-out sets (plan W6.17). Every function returns aggregate
 * numbers only; no item text, prompt or model answer leaves this file.
 *
 * Ollama sets (qa-he, xling, grammar-he, toolcall-he) run per model through
 * /api/chat at temperature 0. asr-he runs the repo's streaming engine
 * (scripts/asr/eval.mjs) on clips written to a temporary folder outside the
 * repo, and ocr-he renders its lines in Chromium and reads them with the
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

/** asr-he: the clips are fetched from the pinned FLEURS revision into a scratch folder, scored, and deleted. */
export function scoreAsr(items, { revision, canary, asrModel }) {
  if (!asrModel || !existsSync(join(asrModel, "tokens.txt"))) return { status: "unavailable", reason: "no ASR model (--asr-model: the folder scripts/asr/fetch-model.sh fills)" };
  const dir = scratch("lumen-heldout-asr-");
  try {
    const py = spawnSync("python3", ["-I", join(ROOT, "scripts/heldout/fetch.py"), "fleurs-audio", "--revision", revision, "--out", dir, "--canary", canary], { input: JSON.stringify(items), encoding: "utf8", stdio: ["pipe", "ignore", "pipe"], maxBuffer: 1 << 26 });
    if (py.status !== 0) return { status: "error", reason: `fetch.py fleurs-audio exited ${py.status}` };
    const out = join(dir, "scores.json");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/asr/eval.mjs"), "--split", `heldout=${dir}`, "--out", out], { cwd: ROOT, env: { ...process.env, LUMEN_ASR_MODEL_DIR: asrModel, GITHUB_STEP_SUMMARY: "" }, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) return { status: "error", reason: `scripts/asr/eval.mjs exited ${r.status}` };
    const s = JSON.parse(readFileSync(out, "utf8")).splits?.heldout ?? {};
    return { n: items.length, wer: s.wer ?? null, cer: s.cer ?? null, p95Ms: s["latency.p95Ms"] ?? s.p95Ms ?? null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

