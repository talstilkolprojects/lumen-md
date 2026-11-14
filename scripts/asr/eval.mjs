#!/usr/bin/env node
/**
 * The plan 6.1 spike: WER / CER and live latency of the streaming engine on
 * the asr-he clips, per split and per source.
 *
 *   node scripts/asr/eval.mjs --split dev=eval/golden/asr-he/dev --split test=$RUNNER_TEMP/golden/asr-he/test [--out asr-scores.json]
 *
 * Each --split names a folder with <part>.json files as hf_build.py writes
 * them. Only numbers are printed (and appended to the job summary): never a
 * transcript, since the test split is held out.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRecognizer, decodeAudio, editDistance, errors, normalizeAsr, rates, scoreWith, transcribeLive } from "../golden/evals/asr-he.mjs";

const args = process.argv.slice(2);
const splits = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--split") splits.push(args[++i].split("="));
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : "asr-scores.json";
const PARTS = ["fleurs", "common-voice"];
// --show NAME: also print the normalised reference / hypothesis of that split's clips —
// only for a public split (the FLEURS validation sample), never the held-out test.
const show = args.includes("--show") ? args[args.indexOf("--show") + 1] : null;
if (show === "test") throw new Error("--show never prints the held-out test split");

function load(dir) {
  const items = [];
  for (const part of PARTS) {
    const f = join(dir, `${part}.json`);
    if (!existsSync(f)) continue;
    for (const it of JSON.parse(readFileSync(f, "utf8")).items) items.push({ ...it, part, audio: join(dir, it.audio) });
  }
  return items;
}

const createT0 = performance.now();
const recognizer = await createRecognizer();
const modelLoadMs = Math.round(performance.now() - createT0);
const done = new Map(); // audio path → result, so "all" does not decode twice
const run = (it) => {
  if (!done.has(it.audio)) done.set(it.audio, transcribeLive(recognizer, decodeAudio(it.audio)));
  return done.get(it.audio);
};
const loadT0 = performance.now();
const ENGINES = { lumen: "Lumen's Zipformer2 port on onnxruntime-web WASM", sherpa: "sherpa-onnx WASM (npm sherpa-onnx 1.13.8)" };
const engine = process.env.LUMEN_ASR_ENGINE ?? "lumen";
const report = { engine: `${ENGINES[engine] ?? engine}, ivrit-ai/zipformer2-66m-streaming-he int8, greedy, 1 thread`, modelLoadMs, splits: {} };
const all = [];
for (const [name, dir] of splits) {
  const items = load(dir);
  if (!items.length) {
    report.splits[name] = { status: "not-built" };
    continue;
  }
  report.splits[name] = await scoreWith(run, items);
  if (name === show) {
    // Error analysis (public split only): which clips carry the errors.
    const byKind = { latin: [], digits: [], hebrewOnly: [] };
    const bag = [];
    const rows = [];
    for (const it of items) {
      const ref = normalizeAsr(it.text);
      const hyp = normalizeAsr((await run(it)).text);
      const e = errors(ref, hyp);
      (/[a-z]/.test(ref) ? byKind.latin : /\d/.test(ref) ? byKind.digits : byKind.hebrewOnly).push(e);
      // Order-free word errors: what WER would be if only the word order were wrong.
      const rw = ref.split(" ").sort();
      const hw = hyp.split(" ").sort();
      bag.push({ ...e, wordErrors: editDistance(rw, hw) });
      rows.push(`${it.id} wer=${(e.wordErrors / Math.max(1, e.words)).toFixed(2)}`);
    }
    const fmt = (l) => (l.length ? `${l.length} clips wer=${rates(l).wer.toFixed(3)}` : "0 clips");
    console.log(`::notice title=asr ${engine} ${name} breakdown::latin ${fmt(byKind.latin)}; digits ${fmt(byKind.digits)}; hebrew-only ${fmt(byKind.hebrewOnly)}; order-free wer=${rates(bag).wer.toFixed(3)}`);
    for (let i = 0; i < items.length; i += 6) {
      const chunk = [];
      for (const it of items.slice(i, i + 6)) chunk.push(`${it.id} ${rows[items.indexOf(it)].split(" ")[1]}%0A  ref: ${normalizeAsr(it.text)}%0A  hyp: ${normalizeAsr((await run(it)).text)}`);
      console.log(`::notice title=asr ${engine} ${name} transcripts ${i / 6 + 1}::${chunk.join("%0A")}`);
    }
  }
  all.push(...items);
}
if (splits.length > 1 && all.length) report.splits.all = await scoreWith(run, all);
report.evalSeconds = Math.round((performance.now() - loadT0) / 100) / 10;

writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
const keys = [...new Set(Object.values(report.splits).flatMap((s) => Object.keys(s)))];
const lines = ["## asr-he — live dictation spike (plan 6.1)", "", `${report.engine}; model load ${modelLoadMs} ms`, "", `| Split | ${keys.join(" | ")} |`, `|---|${keys.map(() => "---").join("|")}|`];
for (const [name, s] of Object.entries(report.splits)) lines.push(`| ${name} | ${keys.map((k) => s[k] ?? "").join(" | ")} |`);
const md = lines.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=asr ${engine} model::load ${modelLoadMs} ms, eval ${report.evalSeconds} s`);
// Also as annotations: readable from the checks API (numbers only).
if (process.env.GITHUB_ACTIONS) for (const [name, s] of Object.entries(report.splits)) console.log(`::notice title=asr ${engine} ${name}::${Object.entries(s).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(md);
