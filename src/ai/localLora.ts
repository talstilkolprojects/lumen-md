/**
 * Local fine-tune (plan 6.12): a LoRA adapter trained on this machine from
 * the user's own notes, served by Ollama. Nothing is uploaded.
 *
 *   6.12.1  The dataset: JSONL in the chat format mlx-lm and PEFT both read
 *           ({"messages": [system, user, assistant]}), from chosen notes
 *           (a folder, or all) and the style profile when there is one.
 *           A held-out set of notes (never trained on) is kept apart for
 *           the acceptance measurement.
 *   6.12.2  Mac: mlx_lm.lora on Mistral 7B Instruct (Apache-2.0) →
 *           mlx_lm.fuse --export-gguf → Modelfile `FROM` the GGUF. (MLX
 *           exports GGUF only for Llama / Mistral / Mixtral.)
 *   6.12.3  NVIDIA: PEFT (the Apache-licensed Unsloth core, not Unsloth
 *           Studio, which is AGPL) → llama.cpp's convert_lora_to_gguf.py →
 *           Modelfile `ADAPTER`.
 *   6.12.4  ⌘K → "Train AI on my style" shows this local route first.
 *
 * Acceptance: style similarity (cosine of embeddings of generated text vs
 * the user's held-out notes) ≥ 10 % above the base model's — measured with
 * `scripts/lora/style-eval.mjs` on the owner's Mac (15.13).
 */

import type { StyleProfile } from "./styleProfiles";

export const MAC_BASE = "mistralai/Mistral-7B-Instruct-v0.3";
export const MAC_BASE_OLLAMA = "mistral:7b-instruct";
export const NVIDIA_BASE = "unsloth/mistral-7b-instruct-v0.3";
export const ADAPTER_NAME = "lumen-style";

const SYSTEM = "Continue the user's writing in their personal voice. Match their tone, vocabulary and sentence length.";

export interface LoraNote {
  path: string;
  text: string;
}

export interface LoraDataset {
  /** train.jsonl and valid.jsonl, as mlx_lm.lora --data <dir> expects. */
  train: string;
  valid: string;
  /** Held-out notes: never in train or valid; the acceptance compares against them. */
  heldOut: LoraNote[];
  stats: { notes: number; trainSamples: number; validSamples: number; heldOut: number; words: number };
}

/** A small deterministic hash (FNV-1a) for a stable split by path. */
export function hashPath(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Split notes into train / valid / held-out by path hash (10 % each for valid and held-out, at least one held-out note). */
export function splitNotes(notes: LoraNote[]): { train: LoraNote[]; valid: LoraNote[]; heldOut: LoraNote[] } {
  const sorted = [...notes].sort((a, b) => hashPath(a.path) - hashPath(b.path) || a.path.localeCompare(b.path));
  const train: LoraNote[] = [];
  const valid: LoraNote[] = [];
  const heldOut: LoraNote[] = [];
  for (const n of sorted) {
    const bucket = hashPath(n.path) % 10;
    if (bucket === 0) heldOut.push(n);
    else if (bucket === 1) valid.push(n);
    else train.push(n);
  }
  // Small vaults: make sure each part has a note when there are enough.
  if (!heldOut.length && train.length > 2) heldOut.push(train.pop()!);
  if (!valid.length && train.length > 2) valid.push(train.pop()!);
  return { train, valid, heldOut };
}

/** Prose chunks of ~`words` words, on paragraph boundaries where possible. */
export function chunkProse(prose: string, words = 300): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let n = 0;
  for (const para of prose.split(/\n{2,}/)) {
    const w = para.split(/\s+/).filter(Boolean).length;
    if (!w) continue;
    if (n && n + w > words) {
      out.push(cur.join("\n\n"));
      cur = [];
      n = 0;
    }
    cur.push(para.trim());
    n += w;
  }
  if (n >= words / 3) out.push(cur.join("\n\n"));
  return out;
}

/** One chat sample: the first part of a chunk as the prompt, the rest as the answer. */
export function sampleOf(chunk: string, system = SYSTEM): string {
  const words = chunk.split(/(\s+)/);
  const cut = Math.max(1, Math.floor(words.length * 0.4));
  const prompt = words.slice(0, cut).join("").trim();
  const completion = words.slice(cut).join("").trim();
  return JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: prompt }, { role: "assistant", content: completion }] });
}

/** The system prompt, with the style profile's tone and rules when there is one. */
export function systemFor(profile: StyleProfile | null): string {
  if (!profile) return SYSTEM;
  return [SYSTEM, `Tone: ${profile.tone}`, ...profile.rules.map((r) => `- ${r}`)].join("\n");
}

/** 6.12.1: the JSONL files and the held-out notes. `prose` strips frontmatter, code and tables. */
export function buildLoraDataset(notes: LoraNote[], opts: { prose: (text: string) => string; profile?: StyleProfile | null; chunkWords?: number; maxSamples?: number }): LoraDataset {
  const usable = notes.map((n) => ({ path: n.path, text: opts.prose(n.text) })).filter((n) => n.text.split(/\s+/).filter(Boolean).length >= 80);
  const parts = splitNotes(usable);
  const system = systemFor(opts.profile ?? null);
  const max = opts.maxSamples ?? 2000;
  const jsonl = (ns: LoraNote[]) => {
    const lines: string[] = [];
    for (const n of ns) for (const c of chunkProse(n.text, opts.chunkWords ?? 300)) if (lines.length < max) lines.push(sampleOf(c, system));
    return lines;
  };
  const train = jsonl(parts.train);
  const valid = jsonl(parts.valid);
  const words = usable.reduce((s, n) => s + n.text.split(/\s+/).filter(Boolean).length, 0);
  return {
    train: train.join("\n") + (train.length ? "\n" : ""),
    valid: valid.join("\n") + (valid.length ? "\n" : ""),
    heldOut: parts.heldOut,
    stats: { notes: usable.length, trainSamples: train.length, validSamples: valid.length, heldOut: parts.heldOut.length, words },
  };
}

/** 6.12.2: the Mac script (Apple silicon, MLX). */
export function macScript(opts: { iters?: number } = {}): string {
  return `#!/usr/bin/env bash
# Lumen — local style fine-tune on a Mac (plan 6.12.2). Nothing is uploaded.
# Needs Apple silicon, Python 3.10+ and Ollama. Unzip lumen-lora.zip and run this in its folder: bash train-mac.sh
set -euo pipefail
python3 -m venv .venv && . .venv/bin/activate
pip install --quiet "mlx-lm>=0.21"
# Base: ${MAC_BASE} (Apache-2.0). MLX exports GGUF only for Llama / Mistral / Mixtral.
mlx_lm.lora --model ${MAC_BASE} --train --data . --iters ${opts.iters ?? 600} --batch-size 2 --num-layers 16 --adapter-path adapters
mlx_lm.fuse --model ${MAC_BASE} --adapter-path adapters --export-gguf --gguf-path ${ADAPTER_NAME}.gguf
cat > Modelfile <<'MF'
FROM ./${ADAPTER_NAME}.gguf
PARAMETER temperature 0.7
MF
ollama create ${ADAPTER_NAME} -f Modelfile
echo "Done: the model '${ADAPTER_NAME}' is in Ollama. Measure it: node scripts/lora/style-eval.mjs --heldout heldout.json --base ${MAC_BASE_OLLAMA} --tuned ${ADAPTER_NAME}"
`;
}

/** 6.12.3: the NVIDIA script (PEFT via the Apache-licensed Unsloth core). */
export function nvidiaScript(opts: { steps?: number } = {}): string {
  return `#!/usr/bin/env bash
# Lumen — local style fine-tune on an NVIDIA GPU (plan 6.12.3). Nothing is uploaded.
# Needs CUDA, Python 3.10+, git and Ollama. Unzip lumen-lora.zip and run this in its folder: bash train-nvidia.sh
# Uses the Unsloth core library (Apache-2.0) only — not Unsloth Studio (AGPL).
set -euo pipefail
python3 -m venv .venv && . .venv/bin/activate
pip install --quiet "unsloth" "trl" "peft" "datasets"
python3 - <<'PY'
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig
model, tok = FastLanguageModel.from_pretrained("${NVIDIA_BASE}", max_seq_length=2048, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(model, r=16, lora_alpha=16, target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])
ds = load_dataset("json", data_files={"train": "train.jsonl", "validation": "valid.jsonl"})
fmt = lambda b: {"text": [tok.apply_chat_template(m, tokenize=False) for m in b["messages"]]}
ds = ds.map(fmt, batched=True)
SFTTrainer(model=model, tokenizer=tok, train_dataset=ds["train"], eval_dataset=ds["validation"],
           args=SFTConfig(dataset_text_field="text", max_steps=${opts.steps ?? 600}, per_device_train_batch_size=2, learning_rate=2e-4, output_dir="out")).train()
model.save_pretrained("adapter")
PY
git clone --depth 1 https://github.com/ggml-org/llama.cpp
pip install --quiet -r llama.cpp/requirements.txt
python3 llama.cpp/convert_lora_to_gguf.py adapter --outfile ${ADAPTER_NAME}-adapter.gguf
cat > Modelfile <<'MF'
FROM ${MAC_BASE_OLLAMA}
ADAPTER ./${ADAPTER_NAME}-adapter.gguf
PARAMETER temperature 0.7
MF
ollama create ${ADAPTER_NAME} -f Modelfile
echo "Done: the model '${ADAPTER_NAME}' is in Ollama. Measure it: node scripts/lora/style-eval.mjs --heldout heldout.json --base ${MAC_BASE_OLLAMA} --tuned ${ADAPTER_NAME}"
`;
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const norm = (a: number[]) => Math.hypot(...a) || 1;
export const cosine = (a: number[], b: number[]) => dot(a, b) / (norm(a) * norm(b));

/** The centroid of unit vectors (the user's style, as held-out notes). */
export function centroid(vectors: number[][]): number[] {
  if (!vectors.length) return [];
  const c = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < c.length; i++) c[i] += v[i] / norm(v);
  return c.map((x) => x / vectors.length);
}

/**
 * The acceptance metric: mean cosine of each generated text to the held-out
 * centroid, for the tuned and the base model, and the relative gain.
 * Pass: gain ≥ 10 %.
 */
export function styleGain(heldOut: number[][], base: number[][], tuned: number[][]): { base: number; tuned: number; gain: number; pass: boolean } {
  const c = centroid(heldOut);
  const mean = (vs: number[][]) => (vs.length ? vs.reduce((s, v) => s + cosine(v, c), 0) / vs.length : 0);
  const b = mean(base);
  const t = mean(tuned);
  const gain = b > 0 ? (t - b) / b : 0;
  return { base: b, tuned: t, gain, pass: gain >= 0.1 };
}
