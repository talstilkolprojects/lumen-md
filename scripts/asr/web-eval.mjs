#!/usr/bin/env node
/**
 * Plan W4.13 — WER of the Whisper models the browser runs for Hebrew
 * dictation (src/ai/transformersEngine.ts: ivrit.ai turbo on WebGPU, Ozen v1
 * on WebGPU or wasm), on FLEURS-he validation (the split where the
 * streaming Zipformer measures 23.6 %) and, when given, the owner's
 * recordings (15.11). The same ONNX files and dtypes as the app, through
 * transformers.js on onnxruntime-node (CPU): the WER is the model's, the
 * latency is this machine's CPU — the WebGPU latency comes from
 * `npm run bench:models` (7.8).
 *
 *   npm run eval:asr-web -- --fleurs <dir with fleurs.json> [--owner <dir>] [--models turbo,ozen] [--out asr-web.json]
 *
 * <dir> is what scripts/asr/fleurs_spike.py writes (models:day builds it).
 * Scores under both normal forms of scripts/golden/evals/asr-he.mjs: v1
 * (6.1's) and v2 (numbers as digits, "%" as a word). Only numbers are
 * printed, never a transcript.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAudio, errors, normalizeAsrV2, percentile, rates } from "../golden/evals/asr-he.mjs";

const args = process.argv.slice(2);
const opt = (flag, dflt) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : dflt);
const splits = [["fleurs-validation", opt("--fleurs")], ["owner", opt("--owner")]].filter(([, d]) => d);
if (!splits.length) {
  console.error("usage: npm run eval:asr-web -- --fleurs <dir> [--owner <dir>] [--models turbo,ozen] [--out asr-web.json]");
  process.exit(2);
}
const outFile = opt("--out", "asr-web.json");

// The app's model ids and dtypes (WHISPER_MODELS and asrOptions in src/ai/transformers.worker.ts).
const MODELS = {
  turbo: { id: "ivrit-ai/whisper-large-v3-turbo-onnx", dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" }, kwargs: { language: "he", task: "transcribe" } },
  ozen: { id: "itayinbar/Ozen-v1", dtype: { encoder_model: "fp16", decoder_model_merged: "fp32" }, kwargs: {} },
};
const chosen = opt("--models", "turbo,ozen").split(",").map((s) => s.trim()).filter(Boolean);
for (const m of chosen) if (!MODELS[m]) throw new Error(`unknown model ${m} (turbo, ozen)`);

function load(dir) {
  const items = [];
  for (const part of ["fleurs", "common-voice", "owner"]) {
    const f = join(dir, `${part}.json`);
    if (!existsSync(f)) continue;
    for (const it of JSON.parse(readFileSync(f, "utf8")).items) items.push({ ...it, part, audio: join(dir, it.audio) });
  }
  return items;
}

const { pipeline } = await import("@huggingface/transformers");
const round = (x) => Math.round(x * 10000) / 10000;
const report = { plan: "W4.13", device: "cpu (onnxruntime-node via transformers.js)", models: {}, splits: {} };

for (const key of chosen) {
  const m = MODELS[key];
  const t0 = performance.now();
  let asr;
  try {
    asr = await pipeline("automatic-speech-recognition", m.id, { device: "cpu", dtype: m.dtype });
  } catch (e) {
    report.models[m.id] = { status: "load-failed", error: String(e?.message ?? e).slice(0, 300) };
    console.log(`${m.id}: could not load (${report.models[m.id].error})`);
    continue;
  }
  const entry = { status: "measured", loadMs: Math.round(performance.now() - t0), splits: {} };
  for (const [name, dir] of splits) {
    const items = load(dir);
    if (!items.length) {
      entry.splits[name] = { status: "not-built" };
      continue;
    }
    const v1 = [];
    const v2 = [];
    const ms = [];
    let audioSeconds = 0;
    for (const it of items) {
      const samples = decodeAudio(it.audio);
      audioSeconds += samples.length / 16000;
      const s0 = performance.now();
      const out = await asr(samples, m.kwargs);
      ms.push(performance.now() - s0);
      const text = Array.isArray(out) ? out.map((o) => o.text ?? "").join(" ") : (out.text ?? "");
      v1.push(errors(it.text, text));
      v2.push(errors(it.text, text, normalizeAsrV2));
    }
    const r1 = rates(v1);
    const r2 = rates(v2);
    entry.splits[name] = {
      items: items.length,
      wer: round(r1.wer),
      cer: round(r1.cer),
      "wer.v2": round(r2.wer),
      "cer.v2": round(r2.cer),
      "latency.p50Ms": Math.round(percentile(ms, 50)),
      "latency.p95Ms": Math.round(percentile(ms, 95)),
      rtf: round(ms.reduce((a, b) => a + b, 0) / 1000 / audioSeconds),
    };
    console.log(`${m.id} ${name}: ${items.length} clips — WER v1 ${(r1.wer * 100).toFixed(1)} %, v2 ${(r2.wer * 100).toFixed(1)} %; p95 ${entry.splits[name]["latency.p95Ms"]} ms (CPU)`);
  }
  report.models[m.id] = entry;
  await asr.dispose?.();
}

// The headline: the model with the lowest FLEURS WER (v2), as `splits` (what models:day reads).
const measured = Object.entries(report.models).filter(([, e]) => e.status === "measured" && typeof e.splits["fleurs-validation"]?.["wer.v2"] === "number");
measured.sort((a, b) => a[1].splits["fleurs-validation"]["wer.v2"] - b[1].splits["fleurs-validation"]["wer.v2"]);
if (measured.length) {
  report.best = measured[0][0];
  report.engine = measured[0][0];
  report.splits = measured[0][1].splits;
}
writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
console.log(`\n${report.best ? `best: ${report.best}` : "no model measured"} → ${outFile}`);
process.exit(measured.length ? 0 : 1);
