#!/usr/bin/env node
/**
 * Speculative decoding on this machine (plan W7.15), against a real Ollama:
 *
 *   node scripts/ollama-speculative.mjs measure [--models a,b] [--runs 3]
 *       tok/s with Ollama's default and with draft_num_predict 0, per
 *       installed model; the decision Lumen makes (default only when
 *       ≥ 10 % faster); "auto" is never slower than off.
 *   node scripts/ollama-speculative.mjs repro [--model m] [--prompts 20]
 *       the same prompts twice with draft_num_predict 0 (temperature 0,
 *       fixed seed): the share of byte-identical outputs (target 100 %);
 *       and, for comparison, twice with Ollama's default.
 *
 *   --url URL   Ollama (default $OLLAMA_URL or http://127.0.0.1:11434)
 *   --out DIR   report directory (default eval/results)
 *
 * Exits 1 when a repro run is not 100 % identical with the pin.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const url = String(flag("url", process.env.OLLAMA_URL ?? "http://127.0.0.1:11434")).replace(/\/+$/, "");
const outDir = flag("out", "eval/results");
const MIN_SPEEDUP = 1.1;

async function api(path, body) {
  const r = await fetch(`${url}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const generate = (model, prompt, options) => api("/api/generate", { model, prompt, stream: false, options: { temperature: 0, seed: 1, ...options } });
const tps = (r) => (r.eval_count && r.eval_duration ? r.eval_count / (r.eval_duration / 1e9) : 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r1 = (x) => Math.round(x * 10) / 10;

const PROMPTS = [
  "Write a short paragraph about why people keep notes.",
  "כתוב פסקה קצרה על חשיבות הקריאה.",
  "List three uses of a calendar, one per line.",
  "סכם במשפט אחד: הפגישה נדחתה ליום רביעי בגלל מחלה.",
  "Explain what a Markdown heading is in two sentences.",
  "תרגם לאנגלית: אני כותב פתקים כל בוקר.",
  "Give a JSON object with keys title and tags for a note about gardening.",
  "מה ההבדל בין כתיב מלא לכתיב חסר? שני משפטים.",
  "Write a haiku about autumn.",
  "תן שלוש תגיות לפתק על תקציב משפחתי.",
];

const version = (await api("/api/version")).version;
const installed = (await api("/api/tags")).models.map((m) => m.name).filter((n) => !/embed/i.test(n));
if (!/^(\d+)\.(\d+)/.test(version) || Number(version.split(".")[0]) === 0 && Number(version.split(".")[1]) < 34) console.warn(`⚠ Ollama ${version}: speculative decoding (draft_num_predict) needs 0.34 or later; the numbers below will be the same with and without.`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(outDir, { recursive: true });

if (cmd === "measure") {
  const models = flag("models") ? flag("models").split(",") : installed;
  const runs = Number(flag("runs", 3));
  const rows = [];
  for (const model of models) {
    process.stdout.write(`${model} … `);
    await generate(model, PROMPTS[0], { num_predict: 32 }); // load
    const on = [];
    const off = [];
    for (let i = 0; i < runs; i++) {
      on.push(tps(await generate(model, PROMPTS[0], { num_predict: 128 })));
      off.push(tps(await generate(model, PROMPTS[0], { num_predict: 128, draft_num_predict: 0 })));
    }
    const withDraft = median(on);
    const withoutDraft = median(off);
    const speedup = withoutDraft ? withDraft / withoutDraft : 0;
    const decision = Math.round(speedup * 1000) >= Math.round(MIN_SPEEDUP * 1000) ? "default" : "off";
    const auto = decision === "default" ? withDraft : withoutDraft;
    rows.push({ model, ollama: version, withDraft: r1(withDraft), withoutDraft: r1(withoutDraft), speedup: r1(speedup), decision, autoNotSlower: auto >= withoutDraft });
    console.log(`${r1(withoutDraft)} → ${r1(withDraft)} tok/s (×${r1(speedup)}) → ${decision}`);
  }
  const file = join(outDir, `speculative-measure-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ ollama: version, url, runs, rows }, null, 2) + "\n");
  console.log(`\n${rows.filter((r) => r.autoNotSlower).length}/${rows.length} models: the automatic choice is not slower than off. Report: ${file}`);
} else if (cmd === "repro") {
  const model = flag("model", installed[0]);
  const n = Math.min(PROMPTS.length * 2, Number(flag("prompts", 20)));
  const prompts = Array.from({ length: n }, (_, i) => PROMPTS[i % PROMPTS.length]);
  const twice = async (options) => {
    let same = 0;
    for (const p of prompts) {
      const a = (await generate(model, p, { num_predict: 160, ...options })).response;
      const b = (await generate(model, p, { num_predict: 160, ...options })).response;
      if (a === b) same++;
    }
    return same;
  };
  const pinned = await twice({ draft_num_predict: 0 });
  const unpinned = await twice({});
  const file = join(outDir, `speculative-repro-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ ollama: version, model, prompts: n, identicalPinned: pinned, identicalDefault: unpinned }, null, 2) + "\n");
  console.log(`${model} on Ollama ${version}: pinned ${pinned}/${n} byte-identical, default ${unpinned}/${n}. Report: ${file}`);
  if (pinned !== n) process.exitCode = 1;
} else {
  console.error("usage: node scripts/ollama-speculative.mjs measure [--models a,b] [--runs 3] | repro [--model m] [--prompts 20]");
  process.exitCode = 2;
}
