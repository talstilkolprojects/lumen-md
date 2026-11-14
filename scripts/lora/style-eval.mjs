#!/usr/bin/env node
/**
 * Plan 6.12 acceptance: is the local LoRA closer to the user's style than
 * its base model? For each held-out note (never trained on), both models
 * continue its opening; the continuations and the held-out notes are
 * embedded, and the mean cosine to the held-out centroid is compared.
 * Pass: the tuned model's is ≥ 10 % above the base's.
 *
 *   node scripts/lora/style-eval.mjs --heldout heldout.json --base mistral:7b-instruct --tuned lumen-style [--embed nomic-embed-text] [--ollama http://localhost:11434]
 *
 * Everything runs against the local Ollama; nothing leaves the machine.
 * Prints scores only (no note text).
 */
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const heldPath = opt("--heldout");
const base = opt("--base");
const tuned = opt("--tuned");
if (!heldPath || !base || !tuned) {
  console.error("usage: style-eval.mjs --heldout heldout.json --base <ollama model> --tuned <ollama model> [--embed nomic-embed-text] [--ollama URL]");
  process.exit(2);
}
const url = opt("--ollama", process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
const embedModel = opt("--embed", "nomic-embed-text");
const { styleGain } = await tsImport("../../src/ai/localLora.ts", import.meta.url);

const held = JSON.parse(readFileSync(heldPath, "utf8"));
if (!Array.isArray(held) || !held.length) throw new Error("heldout.json has no notes");

async function post(path, body) {
  const r = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
const generate = async (model, prompt) => (await post("/api/generate", { model, prompt, stream: false, options: { temperature: 0.7, num_predict: 300, seed: 7 } })).response ?? "";
const embed = async (texts) => (await post("/api/embed", { model: embedModel, input: texts })).embeddings;

const prompts = held.map((n) => {
  const words = String(n.text).split(/\s+/);
  return words.slice(0, Math.max(30, Math.floor(words.length * 0.4))).join(" ");
});
const baseOut = [];
const tunedOut = [];
for (const p of prompts) {
  baseOut.push(await generate(base, p));
  tunedOut.push(await generate(tuned, p));
}
const [hv, bv, tv] = [await embed(held.map((n) => n.text)), await embed(baseOut), await embed(tunedOut)];
const r = styleGain(hv, bv, tv);
console.log(JSON.stringify({ heldOut: held.length, base, tuned, embed: embedModel, cosineBase: +r.base.toFixed(4), cosineTuned: +r.tuned.toFixed(4), gain: `${(r.gain * 100).toFixed(1)} %`, target: "≥ 10 %", pass: r.pass }, null, 2));
process.exitCode = r.pass ? 0 : 1;
