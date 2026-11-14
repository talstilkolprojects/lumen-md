#!/usr/bin/env python3
"""
Export DictaBERT-char-menaked (plan W2.5) to ONNX, quantise it to int8, and
write menaked.json — the vocabulary, class lists and tensor names that
src/text/menaked.ts reads. The checkpoint has a custom head
(trust_remote_code), so it is not an optimum export.

    pip install "torch>=2.2" "transformers>=4.44" "onnx>=1.16" "onnxruntime>=1.18"
    python -I scripts/models/export-menaked.py --revision <commit sha> --out out/dictabert-char-menaked

It prints the registry's `files` array for the two published files
(sha256, size, dtype, licence, attribution): paste it into the
"dictabert-char-menaked" entry of models/registry.json, and publish the
folder on CONVERTED_MODELS_BASE (15.9).

The model card's licence must be CC BY 4.0: the script stops otherwise.
Every assumption about the checkpoint's code is checked; when one does not
hold, the script stops and says which, instead of exporting something the
app would decode wrongly.
"""
import argparse
import json
import os
import sys

REPO = "dicta-il/dictabert-large-char-menaked"


def fail(msg):
    print(f"export-menaked: {msg}", file=sys.stderr)
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--revision", required=True, help="the checkpoint's commit sha (pin it; never a branch)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--opset", type=int, default=17)
    a = ap.parse_args()
    if len(a.revision) < 40:
        fail("--revision must be a full commit sha")

    import torch
    from huggingface_hub import model_info
    from transformers import AutoModel, AutoTokenizer

    card = model_info(REPO, revision=a.revision).card_data or {}
    lic = str(getattr(card, "license", None) or (card.get("license") if isinstance(card, dict) else "")).lower()
    if lic != "cc-by-4.0":
        fail(f"model card licence is {lic!r}, expected cc-by-4.0")

    tok = AutoTokenizer.from_pretrained(REPO, revision=a.revision)
    model = AutoModel.from_pretrained(REPO, revision=a.revision, trust_remote_code=True).eval()
    cfg = model.config

    # The class lists: the checkpoint's own (config first, then the module that defines the head).
    def classes(name):
        for src in (cfg, sys.modules.get(type(model).__module__)):
            for attr in (name, name.upper(), f"{name}_classes", f"{name.upper()}_CLASSES"):
                v = getattr(src, attr, None) if src is not None else None
                if isinstance(v, (list, tuple)) and v and all(isinstance(x, str) for x in v):
                    return list(v)
        fail(f"no '{name}' class list in the config or the model's module: read its modeling file and add it here")

    nikud = classes("nikud")
    shin = classes("shin")

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids, attention_mask):
            out = self.m(input_ids=input_ids, attention_mask=attention_mask)
            logits = getattr(out, "logits", out)
            n = getattr(logits, "nikud_logits", None)
            s = getattr(logits, "shin_logits", None)
            if n is None or s is None:
                raise RuntimeError("the output has no nikud_logits / shin_logits")
            return n, s

    sample = tok(["שלום עולם"], return_tensors="pt")
    with torch.no_grad():
        n, s = Wrap(model)(sample["input_ids"], sample["attention_mask"])
    if n.shape[-1] != len(nikud) or s.shape[-1] != len(shin):
        fail(f"head sizes {n.shape[-1]}/{s.shape[-1]} do not match the class lists {len(nikud)}/{len(shin)}")
    if n.shape[1] != sample["input_ids"].shape[1]:
        fail("one prediction per token expected")

    os.makedirs(a.out, exist_ok=True)
    fp32 = os.path.join(a.out, "model.onnx")
    torch.onnx.export(
        Wrap(model),
        (sample["input_ids"], sample["attention_mask"]),
        fp32,
        input_names=["input_ids", "attention_mask"],
        output_names=["nikud", "shin"],
        dynamic_axes={k: {0: "batch", 1: "seq"} for k in ["input_ids", "attention_mask", "nikud", "shin"]},
        opset_version=a.opset,
    )
    from onnxruntime.quantization import QuantType, quantize_dynamic

    q8 = os.path.join(a.out, "model_quantized.onnx")
    quantize_dynamic(fp32, q8, weight_type=QuantType.QInt8)
    os.remove(fp32)

    vocab = tok.get_vocab()
    single = {t: i for t, i in vocab.items() if len(t) == 1}
    spec = {
        "vocab": single,
        "cls": tok.cls_token_id,
        "sep": tok.sep_token_id,
        "pad": tok.pad_token_id,
        "unk": tok.unk_token_id,
        "nikudClasses": nikud,
        "shinClasses": shin,
        "maxTokens": int(getattr(cfg, "max_position_embeddings", 512)),
        "inputs": {"ids": "input_ids", "mask": "attention_mask"},
        "outputs": {"nikud": "nikud", "shin": "shin"},
        "source": {"repo": REPO, "revision": a.revision, "license": "CC-BY-4.0"},
    }
    with open(os.path.join(a.out, "menaked.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)

    # Smoke: the quantised model and the fp32 one agree on the best class for most characters.
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(q8)
    got = sess.run(None, {"input_ids": sample["input_ids"].numpy(), "attention_mask": sample["attention_mask"].numpy()})
    agree = float((np.argmax(got[0], -1) == n.argmax(-1).numpy()).mean())
    print(f"int8 vs fp32 argmax agreement on the smoke sentence: {agree:.3f}")
    if agree < 0.9:
        fail("the int8 model disagrees with the original on the smoke sentence")
    import hashlib

    reg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "registry.json"), encoding="utf-8"))
    entry = next(m for m in reg["models"] if m["id"] == "dictabert-char-menaked")
    files = []
    for name, dtype in (("model_quantized.onnx", "q8"), ("menaked.json", "config")):
        data = open(os.path.join(a.out, name), "rb").read()
        files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "dtype": dtype, "license": entry["license"], "attribution": entry["attribution"]})
    print(f"nikud classes: {len(nikud)}, shin classes: {len(shin)}")
    print('"files": ' + json.dumps(files, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
