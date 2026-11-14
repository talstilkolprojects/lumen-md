"""FLEURS Hebrew clips from the dataset's *validation* split, for the plan 6.1 spike.

    python -I scripts/asr/fleurs_spike.py --out DIR [--n 30]

The asr-he golden set samples FLEURS's test split, so these clips are
disjoint from it: a wider sample than the set's 8 public dev clips when the
held-out test split cannot be built (no GOLDEN_SEED in the run). Writes
DIR/fleurs.json (hf_build.py's item shape) and DIR/fleurs/*.opus; never
into the repo. CC BY 4.0 (Google, FLEURS).
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("hf_build", HERE.parent / "golden" / "hf_build.py")
hb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hb)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=30)
    a = ap.parse_args()
    out = Path(a.out).resolve()
    if out.is_relative_to(hb.ROOT):
        print("--out must be outside the repo", file=sys.stderr)
        return 2
    rev, files, get, lic = hb.hf_dataset("google/fleurs", "cc-by-4.0", None)
    tsv = get(hb.find(files, r"(^|/)he_il/dev\.tsv$", "FLEURS he_il dev.tsv")[0])
    tar = hb.find(files, r"(^|/)he_il/audio/dev\.tar\.gz$", "FLEURS he_il dev audio")[0]
    groups: dict[str, list[dict]] = {}
    for line in tsv.read_text(encoding="utf-8").splitlines():
        c = line.split("\t")
        if len(c) >= 6:
            groups.setdefault(c[0], []).append({"file": c[1], "raw": c[2], "samples": int(c[-2])})
    pool = []
    for sid, recs in groups.items():
        r = min(recs, key=lambda x: hb.rank_key("lumen-asr-spike:fleurs:take", x["file"]))
        stem = Path(r["file"]).stem
        pool.append({"id": f"fleurs-dev-{sid}", "text": r["raw"], "durationMs": r["samples"] * 1000 // 16000, "audio": f"fleurs/{stem}.opus", "_file": Path(r["file"]).name})
    items = sorted(pool, key=lambda x: hb.rank_key("lumen-asr-spike:fleurs", x["id"]))[: a.n]
    hb.fleurs_audio(get(tar), items, out)
    clean = [{k: v for k, v in it.items() if not k.startswith("_")} for it in items]
    hb.write_json(out / "fleurs.json", {"set": "asr-spike", "part": "fleurs", "split": "fleurs-validation", "license": "CC-BY-4.0", "source": {"dataset": "google/fleurs", "revision": rev, "cardLicense": lic}, "items": clean})
    print(f"fleurs validation: {len(clean)} clips", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
