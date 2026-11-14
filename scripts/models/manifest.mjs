#!/usr/bin/env node
/**
 * One converted (or mirrored) model folder → its published file list (plan 6.0).
 *
 *   node scripts/models/manifest.mjs --dir out/opus-mt-en-he --id opus-mt-en-he \
 *     --revision <hf commit> --via converted [--mirror Xenova/…] [--prune]
 *
 * --prune keeps what transformers.js loads and nothing else: the JSON / text
 * configs and tokenizer, and the ONNX files of the quantisations listed in
 * models/convert-targets.json `keep` (q8 → *_quantized.onnx, q4f16 →
 * *_q4f16.onnx). fp32 weights, PyTorch checkpoints and SentencePiece models
 * are dropped.
 *
 * Writes <dir>/manifest.json: { id, source, revision, via, mirror, license,
 * attribution, files: [{ path, sha256, bytes, dtype, license, attribution }] }
 * and prints it as one GitHub annotation, so the checksums can be copied into
 * models/registry.json from the run (`npm run models:registry`).
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TARGETS = JSON.parse(readFileSync(join(ROOT, "models", "convert-targets.json"), "utf8"));

/** File-name suffix of each transformers.js dtype. */
export const DTYPE_SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4" };

/** The dtype of an .onnx file name ("encoder_model_q4f16.onnx" → q4f16), or null when it is not ONNX. */
export function dtypeOf(name) {
  if (!name.endsWith(".onnx") && !name.endsWith(".onnx_data")) return null;
  const stem = name.replace(/\.onnx(_data)?$/, "");
  for (const [dtype, suffix] of Object.entries(DTYPE_SUFFIX)) {
    if (suffix && stem.endsWith(suffix)) return dtype;
  }
  return "fp32";
}

/** Should a file be published? Configs and tokenizers yes; ONNX only in a kept dtype; weights never. */
export function keepFile(relPath, keep = TARGETS.keep) {
  const name = relPath.split("/").pop();
  const dtype = dtypeOf(name);
  if (dtype) return keep.includes(dtype);
  if (/\.(bin|safetensors|msgpack|h5|ot|pt|pth|spm|model|onnx_data)$/i.test(name)) return false;
  if (name === "manifest.json" || name.startsWith(".")) return false;
  return /\.(json|txt)$/i.test(name);
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

export async function buildManifest({ dir, id, revision = "", via = "converted", mirror = "", prune = false }) {
  const target = TARGETS.models.find((m) => m.id === id);
  if (!target) throw new Error(`unknown model id ${id} (not in models/convert-targets.json)`);
  const files = [];
  for (const rel of walk(dir).sort()) {
    if (!keepFile(rel)) {
      if (prune) rmSync(join(dir, rel));
      continue;
    }
    const full = join(dir, rel);
    files.push({
      path: rel,
      sha256: await sha256(full),
      bytes: statSync(full).size,
      dtype: dtypeOf(rel.split("/").pop()) ?? "config",
      license: target.license,
      attribution: target.attribution,
    });
  }
  return {
    id,
    source: `https://huggingface.co/${target.hf}`,
    revision,
    via,
    mirror: mirror || undefined,
    license: target.license,
    attribution: target.attribution,
    files,
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.dir || !a.id) {
    console.error("usage: manifest.mjs --dir <folder> --id <model id> [--revision sha] [--via converted|mirror] [--mirror repo] [--prune]");
    process.exit(2);
  }
  const m = await buildManifest({ dir: a.dir, id: a.id, revision: a.revision || "", via: a.via || "converted", mirror: a.mirror || "", prune: Boolean(a.prune) });
  writeFileSync(join(a.dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  const onnx = m.files.filter((f) => f.dtype !== "config");
  if (onnx.length === 0) {
    console.log(`::error title=model ${m.id}::no ONNX file in a kept dtype (${TARGETS.keep.join(", ")})`);
    process.exit(1);
  }
  const total = m.files.reduce((s, f) => s + f.bytes, 0);
  const byDtype = Object.fromEntries(TARGETS.keep.map((d) => [d, m.files.filter((f) => f.dtype === d || f.dtype === "config").reduce((s, f) => s + f.bytes, 0)]));
  console.log(`${m.id}: ${m.files.length} files, ${(total / 1e6).toFixed(1)} MB (${Object.entries(byDtype).map(([d, b]) => `${d} ${(b / 1e6).toFixed(1)} MB`).join(", ")})`);
  // Compact form for the annotation (no licence text per file: it is the model's).
  const compact = { id: m.id, revision: m.revision, via: m.via, mirror: m.mirror, files: m.files.map((f) => [f.path, f.sha256, f.bytes]) };
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=model-manifest ${m.id}::${JSON.stringify(compact)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
