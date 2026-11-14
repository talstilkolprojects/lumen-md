"""The public pools of the held-out sets (plan W6.17), for scripts/heldout.mjs only.

    python -I scripts/heldout/fetch.py rows mkqa|massive-train|massive-validation|massive-test|global-mmlu|fleurs
    python -I scripts/heldout/fetch.py fleurs-audio --revision REV --out DIR --canary TEXT  < items.json

`rows` writes JSON lines to stdout: first {"meta": {source, revision, files: {path: sha256}, license}},
then one row per pool item. Nothing is written into the repo, and nothing but the public upstream files
is written to disk (the download cache, outside the repo). scripts/heldout.mjs reads the rows from the
pipe, draws the sets with the evaluator's key and encrypts them straight away.

`fleurs-audio` writes the clips the evaluator names on stdin (and a fleurs.json with their transcripts
and the set's canary) into DIR, which must be outside the repo. The evaluator deletes DIR after scoring.

Licences are checked at the source every time: the dataset card's `license:` on Hugging Face, the
README on GitHub. A mismatch stops the build.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("GOLDEN_CACHE", os.environ.get("LUMEN_HELDOUT_CACHE") or str(Path(tempfile.gettempdir()) / "lumen-heldout-cache"))
spec = importlib.util.spec_from_file_location("hf_build", HERE.parent / "golden" / "hf_build.py")
hb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hb)

if Path(os.environ["GOLDEN_CACHE"]).resolve().is_relative_to(hb.ROOT):
    sys.exit("the download cache must be outside the repo")

MKQA_REPO = "apple/ml-mkqa"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def emit(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")


def meta(source, revision, files, license_):
    emit({"meta": {"source": source, "revision": revision, "files": files, "license": license_}})


# ── MKQA (GitHub) ────────────────────────────────────────────────────────


def mkqa(revision: str | None) -> None:
    if not revision:
        req = urllib.request.Request(f"https://api.github.com/repos/{MKQA_REPO}/commits/main", headers={"User-Agent": hb.UA, "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            revision = json.loads(r.read().decode("utf-8"))["sha"]
    readme = hb.http_get(f"https://raw.githubusercontent.com/{MKQA_REPO}/{revision}/README.md", name=f"mkqa-README-{revision}.md").read_text(encoding="utf-8")
    if not re.search(r"Attribution[- ]ShareAlike 3\.0|CC[ -]BY[ -]SA[ -]3\.0", readme, re.I):
        raise hb.Refused("MKQA: the README of this commit does not say CC BY-SA 3.0 — not building")
    path = hb.http_get(f"https://raw.githubusercontent.com/{MKQA_REPO}/{revision}/dataset/mkqa.jsonl.gz", name=f"mkqa-{revision}.jsonl.gz")
    meta("mkqa", revision, {"dataset/mkqa.jsonl.gz": sha256_file(path)}, "CC-BY-SA-3.0")
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            ex = json.loads(line)
            q = ex.get("queries", {})
            a = ex.get("answers", {})
            emit({"id": str(ex["example_id"]), "he_query": q.get("he"), "en_query": q.get("en"), "answers_he": a.get("he", []), "answers_en": a.get("en", [])})


# ── Hugging Face parquet pools ───────────────────────────────────────────


def parquet_rows(path: Path):
    import pyarrow.parquet as pq

    table = pq.read_table(path)
    names = {}
    md = table.schema.metadata or {}
    if b"huggingface" in md:
        feats = json.loads(md[b"huggingface"]).get("info", {}).get("features", {})
        for k, v in feats.items():
            if isinstance(v, dict) and v.get("_type") == "ClassLabel":
                names[k] = v.get("names", [])
    for row in table.to_pylist():
        for k, ns in names.items():
            if isinstance(row.get(k), int) and ns:
                row[k] = ns[row[k]]
        yield row


def judgments_of(j):
    """A struct of lists (the parquet conversion) or a list of structs, as a list of dicts."""
    if isinstance(j, list):
        return j
    if isinstance(j, dict):
        keys = list(j)
        n = max((len(j[k]) for k in keys if isinstance(j[k], list)), default=0)
        return [{k: j[k][i] for k in keys if isinstance(j[k], list) and i < len(j[k])} for i in range(n)]
    return []


def massive(partition: str, revision: str | None) -> None:
    hb.hf_dataset("AmazonScience/massive", "cc-by-4.0", None)  # the licence, from the card on main
    api, download = hb.hf()
    rev = revision or api.dataset_info("AmazonScience/massive", revision="refs/convert/parquet").sha
    files = api.list_repo_files("AmazonScience/massive", repo_type="dataset", revision=rev)
    want = hb.find(files, rf"(^|/)he-IL/{partition}/[^/]*\.parquet$", f"MASSIVE he-IL {partition}")
    paths = [Path(download("AmazonScience/massive", f, repo_type="dataset", revision=rev, token=hb.TOKEN, cache_dir=hb.CACHE / "hf")) for f in want]
    meta(f"massive-{partition}", rev, {f: sha256_file(p) for f, p in zip(want, paths)}, "CC-BY-4.0")
    for p in paths:
        for r in parquet_rows(p):
            emit({"id": str(r["id"]), "scenario": r.get("scenario"), "intent": r.get("intent"), "utt": r.get("utt"), "annot_utt": r.get("annot_utt"), "judgments": judgments_of(r.get("judgments"))})


def global_mmlu(revision: str | None) -> None:
    rev, files, get, lic = hb.hf_dataset("CohereForAI/Global-MMLU", "apache-2.0", revision)
    he_f = hb.find(files, r"(^|/)he/test-[^/]*\.parquet$", "Global-MMLU he test")
    en_f = hb.find(files, r"(^|/)en/test-[^/]*\.parquet$", "Global-MMLU en test")
    paths = {f: get(f) for f in he_f + en_f}
    meta("global-mmlu", rev, {f: sha256_file(p) for f, p in paths.items()}, "Apache-2.0")
    side = lambda r: {"question": r["question"], "options": [r["option_a"], r["option_b"], r["option_c"], r["option_d"]]}  # noqa: E731
    en = {}
    for f in en_f:
        for r in parquet_rows(paths[f]):
            en[str(r["sample_id"])] = r
    for f in he_f:
        for r in parquet_rows(paths[f]):
            sid = str(r["sample_id"])
            if sid not in en:
                continue
            emit({"id": sid, "subject": r.get("subject"), "he": side(r), "en": side(en[sid]), "answer": str(r["answer"]).strip().upper(), "culturalLabel": r.get("cultural_sensitivity_label")})


# ── FLEURS train ─────────────────────────────────────────────────────────


def fleurs_pool(revision: str | None):
    rev, files, get, lic = hb.hf_dataset("google/fleurs", "cc-by-4.0", revision)
    tsv_f = hb.find(files, r"(^|/)he_il/train\.tsv$", "FLEURS he_il train.tsv")[0]
    tar_f = hb.find(files, r"(^|/)he_il/audio/train\.tar\.gz$", "FLEURS he_il train audio")[0]
    return rev, tsv_f, tar_f, get


def fleurs(revision: str | None) -> None:
    rev, tsv_f, tar_f, get = fleurs_pool(revision)
    tsv = get(tsv_f)
    meta("fleurs", rev, {tsv_f: sha256_file(tsv)}, "CC-BY-4.0")
    seen = {}
    for line in tsv.read_text(encoding="utf-8").splitlines():
        c = line.split("\t")
        if len(c) < 6:
            continue
        sid = c[0]
        # one recording per sentence: the first speaker in file order, so a sentence never repeats
        if sid in seen:
            continue
        seen[sid] = True
        emit({"id": f"fleurs-train-{sid}", "text": c[2], "durationMs": int(c[-2]) * 1000 // 16000, "file": Path(c[1]).name})


def fleurs_audio(revision: str, out: Path, canary: str) -> int:
    out = out.resolve()
    if out.is_relative_to(hb.ROOT):
        print("--out must be outside the repo", file=sys.stderr)
        return 2
    items = json.load(sys.stdin)
    rev, tsv_f, tar_f, get = fleurs_pool(revision)
    work = [{**it, "_file": it["file"]} for it in items]
    hb.fleurs_audio(get(tar_f), work, out)
    hb.write_json(out / "fleurs.json", {"set": "asr-he", "part": "fleurs", "split": "heldout", "canary": canary, "license": "CC-BY-4.0", "source": {"dataset": "google/fleurs", "revision": rev}, "items": [{"id": it["id"], "text": it["text"], "durationMs": it["durationMs"], "audio": it["audio"]} for it in items]})
    (out / "CANARY.txt").write_text(canary + "\n", encoding="utf-8")
    print(f"fleurs train: {len(items)} clips", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["rows", "fleurs-audio"])
    ap.add_argument("source", nargs="?")
    ap.add_argument("--revision", default=None)
    ap.add_argument("--out")
    ap.add_argument("--canary", default="")
    a = ap.parse_args()
    try:
        if a.command == "fleurs-audio":
            return fleurs_audio(a.revision, Path(a.out), a.canary)
        if a.source == "mkqa":
            mkqa(a.revision)
        elif a.source in ("massive-train", "massive-validation", "massive-test"):
            massive(a.source.split("-", 1)[1], a.revision)
        elif a.source == "global-mmlu":
            global_mmlu(a.revision)
        elif a.source == "fleurs":
            fleurs(a.revision)
        else:
            print(f"unknown source {a.source}", file=sys.stderr)
            return 2
    except hb.Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
