#!/usr/bin/env python3
"""Golden-set parts that come from Hugging Face, Tatoeba and Wikipedia (plan 7.1).

The agent container cannot reach these hosts, so .github/workflows/golden-sets.yml
runs this script. It mirrors scripts/lib/golden.mjs exactly: the same seeds,
the same sha256 ordering (splitPool), the same JSON layout and canaries.

  build --job JOB --split dev
      the public dev split into eval/golden/<set>/dev/<part>.json (or, for a
      local-only part, ids + sha256 into selection/<part>.json); then run
      `node scripts/golden.mjs attach-dev <set> <part> --reason …`
  build --job JOB --split test --out DIR          (GOLDEN_SEED in the environment)
      the held-out test split into DIR/<set>/test/ — never inside the repo;
      prints counts and sha256 only
  fetch-local [--set SET]
      the dev items of local-only parts (FLORES+, Belebele, Nakdimon) into
      eval/golden/<set>/local/ (git-ignored), checked against selection/

Every licence is read from the source at run time (the Hugging Face card's
`license:`, Wikipedia's siteinfo) and a mismatch stops the part. Downloads
are data: they are parsed, never executed. Nothing here prints item text.

Run with `python -I`. Needs: pip install -r scripts/golden/requirements.txt,
and ffmpeg for FLEURS.
"""
from __future__ import annotations

import argparse
import bz2
import csv
import difflib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "eval" / "golden"
CACHE = Path(os.environ.get("GOLDEN_CACHE") or Path(tempfile.gettempdir()) / "lumen-golden-cache")
TOKEN = os.environ.get("HF_TOKEN") or None
UA = "LumenGoldenSets/1.0 (https://github.com/talstilkol/lumen-md; eval data builder)"

csv.field_size_limit(1 << 30)


class Refused(Exception):
    """A licence or source check failed: the part is not built."""


# ── The rules of scripts/lib/golden.mjs ─────────────────────────────────


def rank_key(seed: str, key: str) -> str:
    return hashlib.sha256(f"{seed}\0{key}".encode()).hexdigest()


def shuffle(items, seed, key=lambda x: x["id"]):
    return sorted(items, key=lambda x: rank_key(seed, str(key(x))))


def sample(items, n, seed, key=lambda x: x["id"]):
    out = shuffle(items, seed, key)[:n]
    if len(out) < n:
        raise Refused(f"asked for {n} items, only {len(out)} available")
    return out


def dev_seed(set_, part):
    return f"lumen-golden-v1:{set_}:{part}:dev"


def test_seed(secret, set_, part):
    return f"{secret}:{set_}:{part}:test"


def split_pool(pool, set_, part, n_dev, n_test=0, secret=None, key=lambda x: x["id"]):
    """dev = first n_dev by the public seed; test = first n_test of the rest by GOLDEN_SEED; pool order kept."""
    keys = [str(key(x)) for x in pool]
    if len(set(keys)) != len(keys):
        raise Refused(f"{set_}/{part}: duplicate pool keys")
    dev = {str(key(x)) for x in sample(pool, n_dev, dev_seed(set_, part), key)}
    test = set()
    if n_test:
        if not secret:
            raise Refused("the test split needs GOLDEN_SEED")
        rest = [x for x in pool if str(key(x)) not in dev]
        test = {str(key(x)) for x in sample(rest, n_test, test_seed(secret, set_, part), key)}
    return [x for x in pool if str(key(x)) in dev], [x for x in pool if str(key(x)) in test]


def canonical_json(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def content_hash(item: dict) -> str:
    return hashlib.sha256(canonical_json({k: v for k, v in item.items() if k != "id"}).encode()).hexdigest()


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def manifest(set_):
    return json.loads((GOLDEN / set_ / "manifest.json").read_text(encoding="utf-8"))


def part_of(m, part_id):
    for p in m["parts"]:
        if p["id"] == part_id:
            return p
    raise Refused(f"{m['set']} has no part {part_id}")


def tree_hash(split_dir: Path, part_id: str) -> str:
    files = sorted(
        str(p.relative_to(split_dir)).replace(os.sep, "/")
        for p in split_dir.rglob("*")
        if p.is_file() and (p.name == f"{part_id}.json" and p.parent == split_dir or p.relative_to(split_dir).parts[0] == part_id)
    )
    lines = "".join(f"{f}\t{sha256_bytes((split_dir / f).read_bytes())}\n" for f in files)
    return hashlib.sha256(lines.encode()).hexdigest()


# ── Downloads ───────────────────────────────────────────────────────────


def http_get(url: str, name: str | None = None, retries: int = 4, max_age: float | None = None) -> Path:
    """A cached download. `max_age` (seconds): refetch a cached copy older than that, for exports that change
    under a fixed name (Tatoeba's are weekly); None = immutable, cached forever."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (name or hashlib.sha256(url.encode()).hexdigest()[:24])
    if path.exists() and (max_age is None or time.time() - path.stat().st_mtime < max_age):
        return path
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r, open(f"{path}.part", "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            os.replace(f"{path}.part", path)
            return path
        except Exception as e:  # noqa: BLE001 — retry any network error
            last = e
            time.sleep(2 * (attempt + 1))
    raise Refused(f"download failed: {url} ({type(last).__name__})")


def http_json(url: str, params: dict) -> dict:
    q = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(q, headers={"User-Agent": UA})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            time.sleep(2 * (attempt + 1))
    raise Refused(f"API call failed: {url}")


def hf():
    from huggingface_hub import HfApi, hf_hub_download  # imported late: dev machines without it can still run fetch-local for GitHub parts

    return HfApi(token=TOKEN), hf_hub_download


def card_licenses(readme: str) -> list[str]:
    """The `license:` field of a dataset card's YAML front matter (a value or a list)."""
    m = re.match(r"^---\s*\n(.*?)\n---", readme, re.S)
    if not m:
        return []
    out, in_list = [], False
    for line in m.group(1).splitlines():
        if re.match(r"^license\s*:", line):
            v = line.split(":", 1)[1].strip()
            if v:
                out += [x.strip().strip("'\"").lower() for x in v.strip("[]").split(",") if x.strip()]
                in_list = False
            else:
                in_list = True
            continue
        if in_list:
            lm = re.match(r"^\s*-\s*(.+)$", line)
            if lm:
                out.append(lm.group(1).strip().strip("'\"").lower())
            elif line.strip() and not line.startswith(" "):
                in_list = False
    return out


def hf_dataset(repo_id: str, expected_license: str, revision: str | None):
    """Pin a revision and check the card's licence. Returns (revision, files, download, card_license)."""
    api, download = hf()
    info = api.dataset_info(repo_id, revision=revision)
    rev = info.sha
    readme = Path(download(repo_id, "README.md", repo_type="dataset", revision=rev, token=TOKEN, cache_dir=CACHE / "hf")).read_text(encoding="utf-8")
    lic = card_licenses(readme)
    if expected_license not in lic:
        raise Refused(f"{repo_id}: the card says license {lic}, the plan says {expected_license} — not building this part")
    files = api.list_repo_files(repo_id, repo_type="dataset", revision=rev)

    def get(path):
        return Path(download(repo_id, path, repo_type="dataset", revision=rev, token=TOKEN, cache_dir=CACHE / "hf"))

    return rev, files, get, lic


def find(files, pattern, what):
    hits = sorted(f for f in files if re.search(pattern, f))
    if not hits:
        raise Refused(f"no file for {what} (pattern {pattern})")
    return hits


def read_table(path: Path) -> list[dict]:
    if path.suffix == ".parquet":
        import pyarrow.parquet as pq

        return pq.read_table(path).to_pylist()
    if path.suffix == ".jsonl":
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    raise Refused(f"unknown table format {path.name}")


def pinned(set_, part_id) -> dict:
    """The source revision and frozen pool recorded in the committed dev file / selection."""
    m = manifest(set_)
    p = part_of(m, part_id)
    f = p.get("devSelection") or next((x for x in p.get("devFiles", []) if x.endswith(".json")), None)
    if not f:
        return {}
    data = json.loads((GOLDEN / set_ / f).read_text(encoding="utf-8"))
    return {"revision": data.get("source", {}).get("revision"), "pool": data.get("pool"), "dev_ids": [it["id"] for it in data.get("items", [])]}


# ── Parts ───────────────────────────────────────────────────────────────

HE_LETTERS = re.compile(r"[א-ת]")


def fleurs(ctx):
    rev, files, get, lic = hf_dataset("google/fleurs", "cc-by-4.0", ctx["revision"])
    tsv = get(find(files, r"(^|/)he_il/test\.tsv$", "FLEURS he_il test.tsv")[0])
    tar = find(files, r"(^|/)he_il/audio/test\.tar\.gz$", "FLEURS he_il test audio")[0]
    groups = {}
    for line in tsv.read_text(encoding="utf-8").splitlines():
        c = line.split("\t")
        if len(c) < 6:
            continue
        groups.setdefault(c[0], []).append({"file": c[1], "raw": c[2], "norm": c[3], "samples": int(c[-2]), "gender": c[-1]})
    pool = []
    for sid, recs in groups.items():
        r = min(recs, key=lambda x: rank_key("lumen-golden-v1:asr-he:fleurs:take", x["file"]))
        stem = Path(r["file"]).stem
        pool.append({"id": f"fleurs-{sid}", "fleursId": int(sid), "text": r["raw"], "normalized": r["norm"], "durationMs": r["samples"] * 1000 // 16000, "audio": f"fleurs/{stem}.opus", "_file": Path(r["file"]).name})
    ctx["assets"] = lambda items, split_dir: fleurs_audio(get(tar), items, split_dir)
    return {"items": sorted(pool, key=lambda x: x["fleursId"]), "source": {"dataset": "google/fleurs", "revision": rev, "cardLicense": lic, "sampling": "pool: one recording per FLEURS sentence id (the one with the lowest sha256(\"lumen-golden-v1:asr-he:fleurs:take\\0<file>\")); splitPool"}, "fields": {"audio": "Ogg/Opus 32 kbps mono 16 kHz, relative to this split's folder", "text": "raw transcription", "normalized": "FLEURS's normalised transcription", "durationMs": "clip length"}}


def fleurs_audio(tar_path: Path, items, split_dir: Path):
    want = {it["_file"]: it for it in items}
    with tarfile.open(tar_path, "r:gz") as tf, tempfile.TemporaryDirectory() as tmp:
        for m in tf:
            name = Path(m.name).name
            if not m.isfile() or name not in want:
                continue
            src = Path(tmp) / name
            src.write_bytes(tf.extractfile(m).read())
            dst = split_dir / want[name]["audio"]
            dst.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", str(dst)], check=True)
            want.pop(name)
    if want:
        raise Refused(f"FLEURS: {len(want)} clips missing from the archive")


def common_voice(ctx):
    rev, files, get, lic = hf_dataset("mozilla-foundation/common_voice_17_0", "cc0-1.0", ctx["revision"])
    tsv = get(find(files, r"transcript/he/test\.tsv$", "Common Voice he test.tsv")[0])
    tars = find(files, r"audio/he/test/.*\.tar$", "Common Voice he test audio")
    by_sentence = {}
    with open(tsv, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if row.get("path") and row.get("sentence"):
                by_sentence.setdefault(row["sentence"].strip(), []).append(row["path"])
    pool = []
    for sentence, paths in by_sentence.items():
        p = min(paths, key=lambda x: rank_key("lumen-golden-v1:asr-he:common-voice:take", x))
        stem = Path(p).stem
        pool.append({"id": f"cv-{stem}", "text": sentence, "audio": f"common-voice/{stem}.mp3", "_file": Path(p).name})
    ctx["assets"] = lambda items, split_dir: copy_from_tars([get(t) for t in tars], items, split_dir)
    return {"items": sorted(pool, key=lambda x: x["id"]), "source": {"dataset": "mozilla-foundation/common_voice_17_0", "revision": rev, "cardLicense": lic, "sampling": "pool: one validated test clip per distinct sentence; splitPool. Speaker ids and demographics are not copied."}, "fields": {"audio": "MP3 as published, relative to this split's folder", "text": "the sentence read"}}


def copy_from_tars(tars, items, split_dir: Path):
    want = {it["_file"]: it for it in items}
    for t in tars:
        with tarfile.open(t) as tf:
            for m in tf:
                name = Path(m.name).name
                if m.isfile() and name in want:
                    dst = split_dir / want[name]["audio"]
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    dst.write_bytes(tf.extractfile(m).read())
                    want.pop(name)
    if want:
        raise Refused(f"{len(want)} clips missing from the archives")


def flores(ctx):
    rev, files, get, lic = hf_dataset("openlanguagedata/flores_plus", "cc-by-sa-4.0", ctx["revision"])
    he = read_table(get(find(files, r"devtest/.*heb_Hebr.*\.(parquet|jsonl)$", "FLORES+ devtest heb_Hebr")[0]))
    en = {r["id"]: r["text"] for r in read_table(get(find(files, r"devtest/.*eng_Latn.*\.(parquet|jsonl)$", "FLORES+ devtest eng_Latn")[0]))}
    pool = [{"id": f"flores-{r['id']}", "he": r["text"], "en": en[r["id"]]} for r in he if r["id"] in en]
    ctx["hash_fields"] = ["he", "en"]
    return {"items": sorted(pool, key=lambda x: int(x["id"].split("-")[1])), "source": {"dataset": "openlanguagedata/flores_plus", "revision": rev, "cardLicense": lic, "sampling": "pool: every devtest id present in heb_Hebr and eng_Latn; splitPool"}, "fields": {"he": "Hebrew source", "en": "English reference"}}


def belebele(ctx):
    rev, files, get, lic = hf_dataset("facebook/belebele", "cc-by-sa-4.0", ctx["revision"])
    he = read_table(get(find(files, r"heb_Hebr.*\.(parquet|jsonl)$", "Belebele heb_Hebr")[0]))
    en = {(r["link"], str(r["question_number"])): r for r in read_table(get(find(files, r"eng_Latn.*\.(parquet|jsonl)$", "Belebele eng_Latn")[0]))}
    by_link = {}
    for r in he:
        k = (r["link"], str(r["question_number"]))
        if k in en:
            by_link.setdefault(r["link"], []).append((r, en[k]))
    corpus, pool = {}, []
    for link, pairs in sorted(by_link.items()):
        doc = f"bb-d{hashlib.sha256(link.encode()).hexdigest()[:10]}"
        corpus[doc] = pairs[0][0]["flores_passage"]
        r_he, r_en = min(pairs, key=lambda p: rank_key("lumen-golden-v1:retrieval:belebele:take", str(p[0]["question_number"])))
        pool.append({"id": f"belebele-{doc[4:]}", "query": r_en["question"], "passageHe": r_he["flores_passage"], "relevant": [doc]})
    ctx["hash_fields"] = ["query", "passageHe"]
    ctx["extra"] = {"corpus": [{"id": k, "text": v} for k, v in sorted(corpus.items())]}
    return {"items": pool, "source": {"dataset": "facebook/belebele", "revision": rev, "cardLicense": lic, "sampling": "pool: one question per FLORES passage present in heb_Hebr and eng_Latn; splitPool"}, "fields": {"query": "English question", "passageHe": "the relevant Hebrew passage", "relevant": "corpus document id", "corpus": "every Hebrew passage (test split only)"}}


def parquet_split(files, get, split_word):
    hits = [f for f in files if f.endswith(".parquet") and re.search(rf"(^|/)({split_word})[-_.]", Path(f).name)]
    if not hits:
        raise Refused(f"no {split_word} parquet")
    rows = []
    for h in sorted(hits):
        rows += read_table(get(h))
    return rows


def deepset(ctx):
    rev, files, get, lic = hf_dataset("deepset/prompt-injections", "apache-2.0", ctx["revision"])
    seen, pool = set(), []
    for r in parquet_split(files, get, "test"):
        t = (r.get("text") or "").strip()
        if not t or t in seen:
            continue
        seen.add(t)
        pool.append({"id": f"deepset-{hashlib.sha256(t.encode()).hexdigest()[:12]}", "text": t, "label": "injection" if int(r["label"]) == 1 else "benign"})
    ctx["strata"] = ("label", {"injection": lambda n: (3 * n + 2) // 4, "benign": lambda n: n - (3 * n + 2) // 4})
    return {"items": pool, "source": {"dataset": "deepset/prompt-injections", "revision": rev, "cardLicense": lic, "sampling": "pool: the test split, de-duplicated; three quarters injections, one quarter benign (splitPool per label)"}, "fields": {"text": "the prompt", "label": "injection | benign"}}


def gandalf(ctx):
    rev, files, get, lic = hf_dataset("Lakera/gandalf_ignore_instructions", "mit", ctx["revision"])
    seen, pool = set(), []
    for r in parquet_split(files, get, "test"):
        t = (r.get("text") or "").strip()
        if t and t not in seen:
            seen.add(t)
            pool.append({"id": f"gandalf-{hashlib.sha256(t.encode()).hexdigest()[:12]}", "text": t, "label": "injection"})
    return {"items": pool, "source": {"dataset": "Lakera/gandalf_ignore_instructions", "revision": rev, "cardLicense": lic, "sampling": "pool: the test split, de-duplicated; splitPool"}, "fields": {"text": "the prompt", "label": "injection"}}


# Tatoeba: the exports change weekly, so the dev build freezes the pool (sentence ids) in the dev file and the
# test build reads texts for exactly those ids from the current export. An edited sentence shows up as a hash mismatch.
TATOEBA = "https://downloads.tatoeba.org/exports/per_language/"
LANGS = {"heb": "he", "eng": "en", "ara": "ar", "rus": "ru", "fra": "fr", "deu": "de", "jpn": "ja", "cmn": "zh"}


# The exports are rebuilt weekly under the same names: a cached copy older than a day is fetched again, so the
# test build's drift check compares against the current export, not the first one the CI cache ever saw.
TATOEBA_MAX_AGE = 24 * 3600


def tsv_bz2(url, name):
    with bz2.open(http_get(url, name, max_age=TATOEBA_MAX_AGE), "rt", encoding="utf-8", newline="") as f:
        return [line.rstrip("\n").split("\t") for line in f if line.strip()]


# Pools built earlier in this process, by (set, part): a dev run that builds mt-he-en and langid in one job
# must exclude the MT pool from langid before that pool is committed (pinned() still sees nothing then).
BUILT_POOLS: dict = {}


def words(t):
    return len(t.split())


def tatoeba_mt(ctx):
    he = {r[0]: r[2] for r in tsv_bz2(TATOEBA + "heb/heb_sentences.tsv.bz2", "tatoeba-heb_sentences.tsv.bz2") if len(r) >= 3}
    links = tsv_bz2(TATOEBA + "heb/heb-eng_links.tsv.bz2", "tatoeba-heb-eng_links.tsv.bz2")
    en = {r[0]: r[2] for r in tsv_bz2(TATOEBA + "eng/eng_sentences.tsv.bz2", "tatoeba-eng_sentences.tsv.bz2") if len(r) >= 3}
    pool_ids = ctx.get("pool")
    if pool_ids is None:
        refs = {}
        for a, b in links:
            if a in he and b in en:
                refs.setdefault(a, []).append(b)
        pool_ids = [[h, sorted(set(r), key=int)] for h, r in sorted(refs.items(), key=lambda x: int(x[0])) if words(he[h]) >= 4]
    pool = []
    for h, refs in pool_ids:
        if h in he and all(r in en for r in refs):
            pool.append({"id": f"tatoeba-{h}", "he": he[h], "en": [en[r] for r in refs], "tatoeba": {"he": int(h), "en": [int(r) for r in refs]}})
    BUILT_POOLS[("mt-he-en", "tatoeba")] = pool_ids
    ctx["extra"] = {"pool": pool_ids} if ctx["split"] == "dev" else {}
    return {"items": pool, "source": {"exports": TATOEBA, "license": "CC BY 2.0 FR (tatoeba2 templates/Pages/downloads.php)", "sampling": "pool: Hebrew sentences of ≥ 4 words with ≥ 1 linked English sentence, frozen as ids in the dev file's `pool`; splitPool"}, "fields": {"he": "Hebrew source", "en": "every linked English translation (references)", "tatoeba": "sentence ids: https://tatoeba.org/sentences/show/<id>"}}


def tatoeba_langid(ctx):
    # The committed MT pool, plus one this job just built (first dev run: not committed yet).
    mt_pool = {h for h, _ in (pinned("mt-he-en", "tatoeba").get("pool") or []) + (BUILT_POOLS.get(("mt-he-en", "tatoeba")) or [])}
    pool_ids = ctx.get("pool")
    texts = {}
    for code in LANGS:
        for r in tsv_bz2(f"{TATOEBA}{code}/{code}_sentences_CC0.tsv.bz2", f"tatoeba-{code}_sentences_CC0.tsv.bz2"):
            if len(r) >= 3:
                texts[(code, r[0])] = r[2]
    if pool_ids is None:
        pool_ids = {}
        for code in LANGS:
            ids = [i for (c, i), t in texts.items() if c == code and i not in mt_pool and (2 <= words(t) <= 25 if code not in ("jpn", "cmn") else 4 <= len(t) <= 60)]
            pool_ids[code] = sorted(shuffle([{"id": i} for i in ids], f"lumen-golden-v1:langid:tatoeba:pool:{code}")[:400], key=lambda x: int(x["id"]))
            pool_ids[code] = [x["id"] for x in pool_ids[code]]
    pool = [{"id": f"tatoeba-{code}-{i}", "text": texts[(code, i)], "lang": LANGS[code], "tatoeba": int(i)} for code, ids in sorted(pool_ids.items()) for i in ids if (code, i) in texts]
    ctx["strata"] = ("lang", {v: (lambda n: n // 8) for v in LANGS.values()})
    ctx["extra"] = {"pool": pool_ids} if ctx["split"] == "dev" else {}
    return {"items": pool, "source": {"exports": TATOEBA, "license": "CC0 1.0 (sentences_CC0 exports only)", "sampling": "pool: up to 400 CC0 sentences per language (2–25 words; ja/zh 4–60 characters), none from the mt-he-en Tatoeba pool, frozen as ids in the dev file's `pool`; splitPool per language"}, "fields": {"text": "the sentence", "lang": "BCP-47 primary tag", "tatoeba": "sentence id"}}


# Wikipedia: the dev build mines recent edits whose summary names a spelling fix and freezes the candidate
# revision pairs (`pool`); the test build re-reads exactly those revisions (immutable) by id.
WIKI = "https://he.wikipedia.org/w/api.php"
SUMMARY = re.compile(r"(כתיב|איות|הגהה|שגיאת|שגיאות|typo|spelling)", re.I)
WORD = re.compile(r"[א-ת׳״'\"]+")


def wiki_check_license():
    info = http_json(WIKI, {"action": "query", "meta": "siteinfo", "siprop": "rightsinfo", "format": "json"})
    url = info.get("query", {}).get("rightsinfo", {}).get("url", "")
    if "creativecommons.org/licenses/by-sa/4.0" not in url:
        raise Refused(f"he.wikipedia rightsinfo is {url!r}, not CC BY-SA 4.0 — not building")
    return url


def plain(wikitext: str) -> str:
    t = re.sub(r"\{\{[^{}]*\}\}", " ", wikitext)
    t = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<[^>]+>", " ", t, flags=re.S)
    t = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", t)
    t = re.sub(r"'{2,}", "", t)
    return t


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def spelling_fix(old_text: str, new_text: str):
    """The sentence of a one-word spelling fix between two revisions, or None."""
    old_t, new_t = plain(old_text), plain(new_text)
    a, b = old_t.split(), new_t.split()
    ops = [op for op in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes() if op[0] != "equal"]
    if len(ops) != 1 or ops[0][0] != "replace":
        return None
    _, i1, i2, j1, j2 = ops[0]
    if i2 - i1 != 1 or j2 - j1 != 1:
        return None
    wrong, right = a[i1], b[j1]
    wm, rm = WORD.search(wrong), WORD.search(right)
    if not wm or not rm or wm.group(0) == rm.group(0) or not HE_LETTERS.search(rm.group(0)):
        return None
    w, r = wm.group(0), rm.group(0)
    if len(r) < 2 or edit_distance(w, r) > 2 or re.sub(r"[^א-ת]", "", w) == re.sub(r"[^א-ת]", "", r) and w.replace('"', "").replace("'", "") == r.replace('"', "").replace("'", ""):
        return None
    # The sentence around the fix, in the new text.
    pos = 0
    for k in range(j1 + 1):
        pos = new_t.find(b[k], pos)
        if k < j1:
            pos += len(b[k])
    start = max(new_t.rfind(". ", 0, pos), new_t.rfind("\n", 0, pos)) + 1
    end_candidates = [x for x in (new_t.find(". ", pos), new_t.find("\n", pos)) if x != -1]
    end = (min(end_candidates) + 1) if end_candidates else len(new_t)
    clean = re.sub(r"\s+", " ", new_t[start:end]).strip()
    if not (5 <= len(clean.split()) <= 40) or "{" in clean or "|" in clean or "[" in clean:
        return None
    at = clean.find(r)
    if at < 0 or clean.count(r) != 1:
        return None
    text = clean[:at] + w + clean[at + len(r):]
    return {"text": text, "clean": clean, "errors": [{"start": at, "end": at + len(w), "wrong": w, "right": r, "type": "wikipedia", "nonword": None}]}


def utf16_offsets(item):
    """JS (UTF-16) offsets, like the Node builders write. Hebrew is in the BMP, so only astral characters shift them."""
    for e in item["errors"]:
        pre = item["text"][: e["start"]]
        shift = sum(1 for ch in pre if ord(ch) > 0xFFFF)
        e["start"] += shift
        e["end"] += shift + sum(1 for ch in e["wrong"] if ord(ch) > 0xFFFF)
    return item


def revisions(revids):
    out = {}
    for k in range(0, len(revids), 25):
        chunk = revids[k : k + 25]
        d = http_json(WIKI, {"action": "query", "prop": "revisions", "revids": "|".join(map(str, chunk)), "rvprop": "ids|content", "rvslots": "main", "format": "json", "formatversion": "2"})
        for page in d.get("query", {}).get("pages", []):
            for rv in page.get("revisions", []):
                out[rv["revid"]] = (page["title"], rv.get("slots", {}).get("main", {}).get("content", ""))
    return out


def wikipedia(ctx):
    lic = wiki_check_license()
    pool_pairs = ctx.get("pool")
    if pool_pairs is None:
        cands, cont = [], {}
        for _ in range(40):
            d = http_json(WIKI, {"action": "query", "list": "recentchanges", "rcnamespace": "0", "rctype": "edit", "rcshow": "!bot", "rcprop": "title|ids|comment|sizes", "rclimit": "500", "format": "json", "formatversion": "2", **cont})
            for rc in d.get("query", {}).get("recentchanges", []):
                if SUMMARY.search(rc.get("comment", "")) and abs(rc.get("newlen", 0) - rc.get("oldlen", 0)) <= 6 and rc.get("old_revid"):
                    cands.append([rc["old_revid"], rc["revid"]])
            if "continue" not in d or len(cands) >= 1500:
                break
            cont = d["continue"]
        pool_pairs = sorted(cands, key=lambda x: x[1])
    texts = revisions([x for pair in pool_pairs for x in pair])
    pool, kept = [], []
    for old, new in pool_pairs:
        if old not in texts or new not in texts:
            continue
        fix = spelling_fix(texts[old][1], texts[new][1])
        if not fix:
            continue
        kept.append([old, new])
        pool.append(utf16_offsets({"id": f"wiki-{new}", **fix, "page": texts[new][0], "oldid": old, "revid": new, "url": f"https://he.wikipedia.org/w/index.php?diff={new}&oldid={old}"}))
    if ctx["split"] == "dev":
        ctx["extra"] = {"pool": kept}
    return {"items": pool, "source": {"api": WIKI, "rightsinfo": lic, "sampling": "pool: recent non-bot article edits whose summary names a spelling fix, ≤ 6 bytes, exactly one changed word (edit distance ≤ 2), frozen as [oldid, revid] pairs in the dev file's `pool`; splitPool"}, "fields": {"text": "the sentence before the fix", "clean": "after the fix", "errors": "[{start, end, wrong, right, type}] (UTF-16 offsets)", "url": "the diff (attribution: the page's history)"}}


JOBS = {
    "fleurs": [("asr-he", "fleurs", fleurs)],
    "common-voice": [("asr-he", "common-voice", common_voice)],
    "flores": [("mt-he-en", "flores", flores)],
    "belebele": [("retrieval", "belebele", belebele)],
    "deepset": [("injection", "deepset", deepset)],
    "gandalf": [("injection", "gandalf", gandalf)],
    "tatoeba": [("mt-he-en", "tatoeba", tatoeba_mt), ("langid", "tatoeba", tatoeba_langid)],
    "wikipedia-typos": [("typos-he", "wikipedia", wikipedia)],
}


def select(pool, ctx, set_, part_id, n_dev, n_test, secret):
    strata = ctx.get("strata")
    if not strata:
        return split_pool(pool, set_, part_id, n_dev, n_test, secret)
    field, share = strata
    dev, test = [], []
    for value, f in share.items():
        sub = [x for x in pool if x[field] == value]
        d, t = split_pool(sub, set_, f"{part_id}:{value}", f(n_dev), f(n_test) if n_test else 0, secret)
        dev += d
        test += t
    return sorted(dev, key=lambda x: x["id"]), sorted(test, key=lambda x: x["id"])


def build_part(set_, part_id, fn, split, out, secret):
    m = manifest(set_)
    p = part_of(m, part_id)
    pin = pinned(set_, part_id)
    if split == "test" and not pin:
        print(f"{set_}/{part_id}: no dev build yet — run task=dev first", flush=True)
        return None
    ctx = {"split": split, "revision": pin.get("revision") if split == "test" else None, "pool": pin.get("pool") if split == "test" else None}
    built = fn(ctx)
    dev, test = select(built["items"], ctx, set_, part_id, p["dev"], p["test"] if split == "test" else 0, secret)
    if split == "test" and pin.get("dev_ids") and p["status"] != "local-only" and sorted(x["id"] for x in dev) != sorted(pin["dev_ids"]):
        raise Refused(f"{set_}/{part_id}: the rebuilt dev split differs from the committed one (source drift?)")
    items = dev if split == "dev" else test
    canary = m["canary"] if split == "dev" else m["test"]["canary"]
    meta = {"source": built["source"], "fields": built["fields"]}
    if split == "dev" and p["status"] == "local-only":
        fields = ctx["hash_fields"]
        sel = [{"id": it["id"], "sha256": content_hash({k: it[k] for k in fields})} for it in items]
        write_json(GOLDEN / set_ / "selection" / f"{part_id}.json", {"canary": canary, "set": set_, "part": part_id, "split": "dev", "license": p["license"], "note": "Local-only part: the text is never committed. `python -I scripts/golden/hf_build.py fetch-local` downloads it into local/ and checks each sha256.", **meta, "hashFields": fields, "items": sel})
        print(f"{set_}/{part_id}: dev selection of {len(sel)} (ids + sha256)", flush=True)
        return None
    split_dir = (GOLDEN / set_ / "dev") if split == "dev" else (Path(out) / set_ / "test")
    if "assets" in ctx:
        ctx["assets"](items, split_dir)
    clean = [{k: v for k, v in it.items() if not k.startswith("_")} for it in items]
    write_json(split_dir / f"{part_id}.json", {"canary": canary, "set": set_, "part": part_id, "split": split, "license": p["license"], **meta, "items": clean, **ctx.get("extra", {})})
    sha = tree_hash(split_dir, part_id) if split == "test" else None
    print(f"{set_}/{part_id}: {split} {len(clean)} items" + (f" sha256 {sha}" if sha else ""), flush=True)
    return sha


def fetch_local(only_set=None):
    """Dev items of local-only parts into eval/golden/<set>/local/<part>.json, checked against selection/."""
    for set_dir in sorted(GOLDEN.iterdir()):
        if not (set_dir / "manifest.json").exists() or (only_set and set_dir.name != only_set):
            continue
        m = manifest(set_dir.name)
        for p in m["parts"]:
            if p["status"] != "local-only" or not p.get("devSelection"):
                continue
            sel = json.loads((set_dir / p["devSelection"]).read_text(encoding="utf-8"))
            want = {it["id"]: it for it in sel["items"]}
            fields = sel.get("hashFields") or ["text"]
            if p["id"] == "nakdimon":
                repo, commit = sel["source"]["repo"].split("github.com/")[1], sel["source"]["commit"]
                got = []
                for it in sel["items"]:
                    raw = http_get(f"https://raw.githubusercontent.com/{repo}/{commit}/{it['path']}", f"nakdimon-{it['path'].replace('/', '_')}").read_text(encoding="utf-8")
                    got.append({"id": it["id"], "text": raw.replace("\r", "").split("\n")[it["line"] - 1]})
            else:
                fn = {"flores": flores, "belebele": belebele}[p["id"]]
                ctx = {"split": "dev", "revision": sel["source"].get("revision"), "pool": None}
                pool = {x["id"]: x for x in fn(ctx)["items"]}
                got = [{"id": i, **{k: pool[i][k] for k in fields}} for i in want if i in pool]
            bad = [g["id"] for g in got if content_hash(g) != want[g["id"]]["sha256"]]
            if bad or len(got) != len(want):
                raise Refused(f"{set_dir.name}/{p['id']}: {len(bad)} items do not match their frozen sha256, {len(want) - len(got)} missing")
            write_json(set_dir / "local" / f"{p['id']}.json", {"set": set_dir.name, "part": p["id"], "split": "dev", "license": p["license"], "note": "Local only: never commit (eval/golden/*/local/ is git-ignored).", "items": got})
            print(f"{set_dir.name}/{p['id']}: {len(got)} dev items in local/", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--job", required=True, choices=sorted(JOBS))
    b.add_argument("--split", choices=["dev", "test"], default="dev")
    b.add_argument("--out")
    f = sub.add_parser("fetch-local")
    f.add_argument("--set")
    a = ap.parse_args()
    try:
        if a.cmd == "fetch-local":
            fetch_local(a.set)
            return 0
        secret = os.environ.get("GOLDEN_SEED") if a.split == "test" else None
        if a.split == "test":
            if not secret:
                raise Refused("the test split needs GOLDEN_SEED")
            if not a.out or Path(a.out).resolve().is_relative_to(ROOT):
                raise Refused("--out must be outside the repo")
        for set_, part_id, fn in JOBS[a.job]:
            build_part(set_, part_id, fn, a.split, a.out, secret)
        return 0
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 3
    except Exception as e:  # noqa: BLE001 — never print data: only the error's type and where
        tb = e.__traceback__
        while tb and tb.tb_next:
            tb = tb.tb_next
        where = f"{Path(tb.tb_frame.f_code.co_filename).name}:{tb.tb_lineno}" if tb else "?"
        print(f"error: {type(e).__name__} at {where}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
