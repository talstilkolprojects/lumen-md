#!/usr/bin/env node
/**
 * Plan W2.7 — pin the speaker diarization models (owner tool).
 *
 *   node scripts/meetings/diarization-pin.mjs
 *        prints the commands that find each network's repository, revision,
 *        file, size and sha256 on Hugging Face, and the licence to check
 *   node scripts/meetings/diarization-pin.mjs --model segmentation|embedding --repo <owner/name> --revision <40-hex> --file <path.onnx> --bytes <n> --sha256 <64-hex> --license <spdx>
 *        checks the values and prints the block to paste into
 *        DIARIZATION_MODELS in src/meetings/diarizeModels.ts
 *
 * Nothing is downloaded from here and nothing is guessed: until both blocks
 * are pasted, meeting transcripts have no speakers.
 */
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

export function validate(v) {
  const errors = [];
  if (!["segmentation", "embedding"].includes(v.model)) errors.push("--model must be segmentation or embedding");
  if (!/^[\w.-]+\/[\w.-]+$/.test(v.repo ?? "")) errors.push("--repo must be owner/name");
  if (!/^[0-9a-f]{40}$/.test(v.revision ?? "")) errors.push("--revision must be a 40-character commit sha (not a branch)");
  if (!/^[\w./-]+\.onnx$/.test(v.file ?? "") || (v.file ?? "").includes("..")) errors.push("--file must be a path to an .onnx file inside the repository");
  if (!(Number(v.bytes) > 0)) errors.push("--bytes must be the file's size in bytes");
  if (!/^[0-9a-f]{64}$/.test(v.sha256 ?? "")) errors.push("--sha256 must be the LFS sha256 (64 hex)");
  if (!v.license) errors.push("--license must be the licence you checked on the model card (e.g. MIT, Apache-2.0, CC-BY-4.0)");
  if (/\b(NC|ND)\b|non-?commercial/i.test(v.license ?? "")) errors.push("non-commercial or no-derivatives licences are not allowed (licence gate 0.10)");
  return errors;
}

export function main() {
  if (args.length === 0 || args.includes("--help")) {
    console.log(`Pin the two networks of the pyannote 3.1 pipeline as ONNX (on a machine with Hugging Face access).

  1. Find ONNX exports (segmentation-3.0 is MIT; check each export's own licence):
    curl -s "https://huggingface.co/api/models?search=segmentation-3.0&filter=onnx" | jq -r '.[].id'
    curl -s "https://huggingface.co/api/models?search=wespeaker&filter=onnx" | jq -r '.[].id'

  2. For a chosen repository <repo>: the pinned revision, then each file's size and sha256:
    curl -s "https://huggingface.co/api/models/<repo>" | jq -r '.sha, .cardData.license'
    curl -s "https://huggingface.co/api/models/<repo>/tree/<revision>?recursive=1" | jq -r '.[] | select(.path|endswith(".onnx")) | "\\(.path) \\(.lfs.size // .size) \\(.lfs.oid // "-")"'

  3. Check the export's input / output names (they must match DIARIZATION_MODELS: segmentation
     input "input_values" → output "logits" [1, frames, 7]; embedding input "feats" [1, T, 80] → "embs"):
    python3 -c "import onnx,sys; m=onnx.load(sys.argv[1]); print([i.name for i in m.graph.input], [o.name for o in m.graph.output])" <file.onnx>

  4. Print the block to paste (once per network):
    node scripts/meetings/diarization-pin.mjs --model segmentation --repo <repo> --revision <sha> --file <path.onnx> --bytes <n> --sha256 <hex> --license MIT
    node scripts/meetings/diarization-pin.mjs --model embedding    --repo <repo> --revision <sha> --file <path.onnx> --bytes <n> --sha256 <hex> --license <licence>

  5. Register both files in models/registry.json (licence gate 0.10) and credit them in Settings → About → Credits.`);
    return;
  }

  const v = { model: flag("--model"), repo: flag("--repo"), revision: flag("--revision"), file: flag("--file"), bytes: flag("--bytes"), sha256: flag("--sha256"), license: flag("--license") };
  const errors = validate(v);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  console.log(`Paste into DIARIZATION_MODELS.${v.model} (src/meetings/diarizeModels.ts), keeping its input/output fields:

    repo: ${JSON.stringify(v.repo)}, revision: ${JSON.stringify(v.revision)}, file: ${JSON.stringify(v.file)}, bytes: ${Number(v.bytes)}, sha256: ${JSON.stringify(v.sha256)}, license: ${JSON.stringify(v.license)},`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
