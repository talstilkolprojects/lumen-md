---
title: Held-out sets
description: Eval sets the feature authors never see — encrypted, scored by a separate evaluator that reports aggregates only, with a contamination check on the repo and every PR.
---

Lumen's dev sets and probes are written by the same agents that write the
code, so they tend to pass: HeQ dev is already at 1.0 and no longer tells
two versions apart. The held-out sets are the check that the authors cannot
tune for. `npm run heldout` is their evaluator.

## What is held out

| Set | Items | What it measures | Source | Licence |
|---|---|---|---|---|
| `qa-he` | 300 | closed-book Hebrew QA: a short answer that matches a reference or alias | MKQA (Apple), he + en answers | CC BY-SA 3.0 |
| `ocr-he` | 120 | OCR CER, clean and degraded, in 4 fonts the golden OCR set does not use | MKQA Hebrew questions, rendered; Fontsource fonts | CC BY-SA 3.0 (text); fonts OFL 1.1, not shipped |
| `asr-he` | 200 | dictation WER and CER | FLEURS he_il, **train** split (the repo samples only validation and test) | CC BY 4.0 |
| `grammar-he` | 300 | "does the sentence have an error?": precision, recall, F1 | MASSIVE he-IL dev partition, labelled by its crowd judgments (150 flawed, 150 clean) | CC BY 4.0 |
| `xling` | 200 | the same question in Hebrew, in English and mixed: accuracy and the Hebrew − English gap | Global-MMLU he + en | Apache 2.0 |
| `toolcall-he` | 300 | valid tool calls, right intent, slot F1 | MASSIVE he-IL test partition (intents as tools, slots as arguments) | CC BY 4.0 |

None of these pools is used by a dev set, a golden set or a probe in this
repo; a test (`src/__tests__/heldout.test.ts`) checks it.

## How the items stay hidden

- **Which items** a set holds is decided by an HMAC keyed with the
  evaluator's secret. The pools are public, but without the key nobody can
  tell which of their items are held out.
- **The items** exist only in bundles encrypted to the evaluator's key
  (X25519, HKDF-SHA256, ChaCha20-Poly1305), in `~/.cache/lumen-heldout` or
  `$LUMEN_HELDOUT_DIR`, never in the repo.
- **The key** comes from Tal or the nightly host at run time
  (`LUMEN_HELDOUT_KEY` or `--key-file`). A key file inside the checkout is
  refused.
- **The repo** holds only `eval/heldout/manifest.json` (sources, sizes,
  licences, one canary per set, and each set's seal) and
  `eval/heldout/commitments/` (keyed hashes of the items).
- **The output** is aggregate numbers. Item ids in it are keyed hashes.
  Audio and images are written to a temporary folder outside the repo and
  deleted after scoring.

## Commands

```sh
npm run heldout -- status                       # no key needed
npm run heldout -- keygen                       # owner / nightly host, once
npm run heldout -- build --record               # fetch the pools, draw, encrypt, record the seals
npm run heldout -- run --models qwen2.5:7b,gemma3:12b --asr-model <dir>
npm run heldout -- scan --require-key --prs open
npm run heldout -- log --verify
npm run heldout -- export --to <run recipient> --out <file>   # a one-run copy for a cloud GPU
```

`export` re-encrypts the sets to a key made for one run of
[models:cloud](/ai/models-cloud/). The copy can score, but it cannot build
or export, and it carries no part of the evaluator's key.

`build` needs Python 3 with `pip install -r scripts/golden/requirements.txt`
and network access to Hugging Face, GitHub and npm. It checks each licence
at the source again, and it refuses a mismatch.

## The contamination check

`npm run heldout -- scan` reads every file git tracks (and the untracked
files that are not ignored). It can also read the added lines of a diff
(`--diff <rev>`), the diffs and bodies of PRs (`--prs 443,449` or
`--prs open`), and more folders (`--paths`). It flags:

- any set's canary, which works without the key;
- the evaluator's key;
- with the key, any held-out item: one 13-word sequence of it, half of its
  8-word sequences in one document, or a short item whole. Nikud,
  punctuation and line breaks don't hide a copy.

It exits 1 on any finding. `models:day` runs it before scoring.

## Versions and rotation

Every set has a version, and every report names the versions and digests it
used. Each quarter, `build --rotate --record` replaces 20 % of every set with
items no version has used before.

## The log

Each build and each score request is appended to `log.jsonl` next to the
bundles, with who asked, when, on which commit and versions, and the hash of
the result. Every entry carries the hash of the one before it, so
`log --verify` catches an edited or removed entry. Every results file also
carries its own log entry.

## In models:day

When the evaluator key is present, `npm run models:day` adds the `heldout`
step. It fetches the dictation model, builds the bundles if they are
missing, runs the scan, and then scores all six sets on `qwen2.5:7b` and
`gemma3:12b`. Without the key, the step is listed as blocked.
