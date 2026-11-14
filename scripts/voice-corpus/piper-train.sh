#!/usr/bin/env bash
# Train the first open Hebrew Piper voice (plan W7.10) from the CC0 corpus that
# scripts/voice-corpus/kit.mjs check wrote. An owner / GPU step: Tal's Mac
# (MPS, slow) or the free GPU of W6.18 (Kaggle T4). Piper: rhasspy/piper, MIT,
# the archived version 6.2 pinned (training code in src/python).
#
#   CORPUS=corpus/ OUT=train/ bash scripts/voice-corpus/piper-train.sh
#
# Licence rule (acceptance): voice, data and code CC0 or MIT only, approved in
# gate 0.10. So no warm start from an existing checkpoint unless its weights
# are CC0/MIT too: by default this trains from scratch (longer, still ~1 day
# on one T4 at medium quality for 2 hours of audio).
set -euo pipefail
CORPUS=${CORPUS:?the LJSpeech folder from kit.mjs check}
OUT=${OUT:-train}
PIPER_REF=${PIPER_REF:-36fec21382b9687114b81a529d0d028b35905cd1}   # rhasspy/piper v1.2.0 (its last tagged release)
EPOCHS=${EPOCHS:-3000}
CKPT=${CKPT:-}            # a CC0/MIT checkpoint to fine-tune from, after gate 0.10

if [ ! -d piper ]; then git clone https://github.com/rhasspy/piper.git && git -C piper checkout "$PIPER_REF"; fi
python3 -m venv .venv-piper && . .venv-piper/bin/activate
pip install -q --upgrade pip wheel && pip install -q -e piper/src/python && bash piper/src/python/build_monotonic_align.sh
command -v espeak-ng >/dev/null || { echo "install espeak-ng (it has a Hebrew voice: he)"; exit 2; }

python3 -m piper_train.preprocess --language he --input-dir "$CORPUS" --output-dir "$OUT" \
  --dataset-format ljspeech --single-speaker --sample-rate 22050
python3 -m piper_train --dataset-dir "$OUT" --accelerator gpu --devices 1 --batch-size 16 \
  --validation-split 0.0 --num-test-examples 0 --max_epochs "$EPOCHS" --checkpoint-epochs 50 \
  --quality medium --precision 32 ${CKPT:+--resume_from_checkpoint "$CKPT"}
LAST=$(ls -t "$OUT"/lightning_logs/version_*/checkpoints/*.ckpt | head -1)
python3 -m piper_train.export_onnx "$LAST" "$OUT/he_IL-lumen-medium.onnx"
cp "$OUT/config.json" "$OUT/he_IL-lumen-medium.onnx.json"
echo "voice: $OUT/he_IL-lumen-medium.onnx (+ .onnx.json). Next: the listening test (kit.mjs mos) and RTF in the browser worker (W2.6)."
