#!/usr/bin/env python3
"""Export a Hugging Face image dataset (Parquet with embedded images) to the
"image-jsonl" format of src/eval/public/adapters/handwriting.ts (plan
W11.H14): png files plus export/items.jsonl with {"id", "writer", "image", "text"}.

    python3 scripts/eval-public/export_hf_images.py eval/public/.data/ocr-handwriting-ivrit

Needs `pip install datasets pillow`. Output stays under the git-ignored
eval/public/.data/.
"""
import argparse, json, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--text-column", default=None)
    ap.add_argument("--writer-column", default=None)
    a = ap.parse_args()
    from datasets import load_dataset, Image  # noqa: E402
    files = [os.path.join(r, f) for r, _, fs in os.walk(a.dir) for f in fs if f.endswith(".parquet")]
    if not files:
        sys.exit(f"no .parquet files under {a.dir}")
    ds = load_dataset("parquet", data_files=files, split="train")
    img = next((c for c in ds.column_names if c in ("image", "img")), None)
    col = a.text_column or next((c for c in ("text", "transcription", "label", "gt") if c in ds.column_names), None)
    wcol = a.writer_column or next((c for c in ("writer", "writer_id", "author") if c in ds.column_names), None)
    if not img or not col:
        sys.exit(f"columns {ds.column_names}: need an image and a text column (--text-column)")
    ds = ds.cast_column(img, Image(decode=True))
    out = os.path.join(a.dir, "export")
    os.makedirs(os.path.join(out, "images"), exist_ok=True)
    with open(os.path.join(out, "items.jsonl"), "w", encoding="utf-8") as f:
        for i, row in enumerate(ds):
            rel = os.path.join("export", "images", f"{i:06d}.png")
            row[img].save(os.path.join(a.dir, rel))
            f.write(json.dumps({"id": str(row.get("id", i)), "writer": str(row.get(wcol, "")) if wcol else "", "image": rel, "text": row[col]}, ensure_ascii=False) + "\n")
    print(f"wrote {len(ds)} lines to {out}/items.jsonl")

if __name__ == "__main__":
    main()
