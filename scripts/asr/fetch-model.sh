#!/usr/bin/env bash
# Download the ivrit.ai Zipformer2 streaming model (CC BY 4.0, int8, sherpa-onnx export) into $1
# (default ~/.cache/lumen-asr/zipformer2-66m-streaming-he) and check each file's sha256.
# Used by CI (the ASR and golden-sets workflows) and by developers; never bundled.
set -euo pipefail
dir="${1:-$HOME/.cache/lumen-asr/zipformer2-66m-streaming-he}"
rev="${LUMEN_ASR_MODEL_REV:-ee769a2a13b887f91572eec349458bfb0fe79e7a}" # pinned, as in src/ai/dictation/models.ts
mkdir -p "$dir"
declare -A sha=(
  [encoder.int8.onnx]=6c6febcb74a09435315a1d872a6539f6e7fc2c333533f14c74edc0e85c49ffcd
  [decoder.int8.onnx]=feb03e7c8aa761593a9284a6fa1e91259be3702de75f630062256c1a59c5a906
  [joiner.int8.onnx]=1d2c6d8e6dabc5eb52de52e95718e9bdfbffbfe7ead3808fb5ffd74e83bd9cae
)
for f in encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt; do
  [ -s "$dir/$f" ] || curl -fsSL --retry 3 -o "$dir/$f" "https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he/resolve/$rev/sherpa-onnx/$f"
  if [ -n "${sha[$f]:-}" ] && [ "${LUMEN_ASR_MODEL_REV:-}" = "" ]; then
    echo "${sha[$f]}  $dir/$f" | sha256sum -c --quiet - || { rm -f "$dir/$f"; echo "sha256 mismatch: $f" >&2; exit 1; }
  fi
done
ls -l "$dir"
echo "$dir"
