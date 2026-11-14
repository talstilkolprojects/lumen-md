#!/usr/bin/env python3
"""Export a Hugging Face audio dataset (Parquet with embedded audio) to the
"audio-jsonl" format of src/eval/public/adapters/asr.ts (plan W11.H6):
wav files plus export/items.jsonl with {"id", "audio", "text"}.

    python3 scripts/eval-public/export_hf_audio.py eval/public/.data/<id> [--split test] [--text-column text]

Runs where the data was downloaded (`npm run eval:public -- fetch <id>`);
needs `pip install datasets soundfile`. Everything it writes stays under the
git-ignored eval/public/.data/.
"""
import argparse, json, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--split", default="test")
    ap.add_argument("--text-column", default=None, help="default: the first of text, transcript, sentence, normalized_text")
    a = ap.parse_args()
    from datasets import load_dataset, Audio  # noqa: E402
    import soundfile as sf  # noqa: E402
    files = [os.path.join(r, f) for r, _, fs in os.walk(a.dir) for f in fs if f.endswith(".parquet")]
    if not files:
        sys.exit(f"no .parquet files under {a.dir}")
    ds = load_dataset("parquet", data_files=files, split="train").cast_column("audio", Audio(decode=True))
    col = a.text_column or next((c for c in ("text", "transcript", "sentence", "normalized_text") if c in ds.column_names), None)
    if not col:
        sys.exit(f"no text column among {ds.column_names}; pass --text-column")
    out = os.path.join(a.dir, "export")
    os.makedirs(os.path.join(out, "audio"), exist_ok=True)
    with open(os.path.join(out, "items.jsonl"), "w", encoding="utf-8") as f:
        for i, row in enumerate(ds):
            rid = str(row.get("id", row.get("uuid", i)))
            wav = os.path.join("export", "audio", f"{i:06d}.wav")
            sf.write(os.path.join(a.dir, wav), row["audio"]["array"], row["audio"]["sampling_rate"])
            f.write(json.dumps({"id": rid, "audio": wav, "text": row[col]}, ensure_ascii=False) + "\n")
    print(f"wrote {len(ds)} items to {out}/items.jsonl (text column: {col})")

if __name__ == "__main__":
    main()
