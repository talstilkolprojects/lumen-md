#!/usr/bin/env python3
"""Parity samples for the ivrit.ai leaderboard normaliser port (plan W11.H6).

Runs the leaderboard's own Python normaliser on 50 reference texts (the first
25 of eval-d1 and of eval-whatsapp, after `fetch` + `export_hf_audio.py`) and
writes eval/public/.data/normalizer-parity.jsonl with {"input", "expected"};
`npm run eval:public -- parity` then compares the TypeScript port
(src/eval/public/normalize.ts) with it, line by line.

    python3 scripts/eval-public/normalizer_parity.py --module <python module path> --function <name>

--module is the .py file in a checkout of the leaderboard's code at a pinned
commit (record the commit in the PR that marks the parity verified).
"""
import argparse, importlib.util, json, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "eval", "public", ".data")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--module", required=True)
    ap.add_argument("--function", required=True)
    ap.add_argument("--per-set", type=int, default=25)
    a = ap.parse_args()
    spec = importlib.util.spec_from_file_location("ivrit_norm", a.module)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = getattr(mod, a.function)
    rows = []
    for sid in ("asr-ivrit-eval-d1", "asr-ivrit-eval-whatsapp"):
        p = os.path.join(DATA, sid, "export", "items.jsonl")
        if not os.path.exists(p):
            sys.exit(f"missing {p}: npm run eval:public -- fetch {sid}, then export_hf_audio.py")
        with open(p, encoding="utf-8") as f:
            for line in list(f)[: a.per_set]:
                t = json.loads(line)["text"]
                rows.append({"set": sid, "input": t, "expected": fn(t)})
    out = os.path.join(DATA, "normalizer-parity.jsonl")
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} samples to {out}")

if __name__ == "__main__":
    main()
