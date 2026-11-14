---
title: External OCR benchmark (HebOCRBench)
description: How Lumen's OCR is measured on HebOCRBench, an outside Hebrew benchmark whose answers only its organisers hold, and where the scores are published.
---

Our own OCR numbers (the `ocr-he` set, plan 7.5) come from a set we built.
[HebOCRBench](https://huggingface.co/datasets/ssdataanalysis/hebocrbench-v1)
is an outside Hebrew benchmark. Its organisers keep the gold answers, so a
score there can't come from a test we picked.

## The five tracks

| Track | Images |
| --- | --- |
| bidi (Hebrew mixed with Latin text and digits) | 192 |
| lines | 28,414 |
| pages | 700 |
| tables | 61 |
| robustness (blur, noise, skew) | 4,900 |

## Running a submission

The input package stays outside the repository, on the Sandbox or the second
host. The software is MIT, but each image keeps its own source's terms.

```sh
node scripts/ocr/hebocrbench.mjs predict /data/hebocrbench /data/hob-out
node scripts/ocr/hebocrbench.mjs check-clean /data/hebocrbench
```

`predict` runs the app's own OCR path (`recognizeWithMixedFix` with the
committed `heb` and `eng` models) on every image. It writes
`predictions/<track>.jsonl` and `submission.json`, which records the version,
the commit and the models' hashes. Predictions are in logical order and NFC,
with no direction marks. `check-clean` fails if any package image is in the
repository or in `dist`.

## Publishing the score

Once the organisers return a score for each track, run:

```sh
node scripts/ocr/hebocrbench.mjs record scores.json --internal internal.json
```

It adds the record, with its date and version, to
`eval/external/hebocrbench.json`. If our internal CER and the external CER
differ by more than 5 points on a track, the command exits 3 and a fix task
is opened.

## The bidi track as a regression check

`hebocrbench.mjs bidi <before> <after>` compares two runs of the bidi track.
A new direction mark (W5.4) or a newly reversed Hebrew word (W5.5) fails it.

## Scores

None yet. The first submission is an owner step.
