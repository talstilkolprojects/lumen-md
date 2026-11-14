---
title: Hebrew niqqud on this device
description: Add or remove vowel points (niqqud) in Hebrew text with a model that runs in your browser.
---

Three commands in `⌘K`, on the selection — or the whole note when nothing
is selected:

| Command | What it does |
|---|---|
| **Hebrew: add niqqud** | Points every Hebrew word. Existing points are replaced. |
| **Hebrew: add partial niqqud** | Points only the words the model finds ambiguous, the way modern texts point a word that could be read two ways. |
| **Hebrew: remove niqqud** | Strips the points. Needs no model. |

English, code, numbers and punctuation pass through unchanged. Before
anything is written, Lumen checks that the letters themselves did not
change — only points are added or removed.

## The model

[Nakdimon](https://github.com/elazarg/nakdimon) (Elazar Gershuni, MIT,
≈ 21 MB) runs in a background worker with ONNX Runtime on WebAssembly,
so it works on any device, without a GPU and offline once downloaded.
It is downloaded only after a dialog that shows its size, licence and
attribution, verified against the checksum in `models/registry.json`,
and kept on this device.

The download is served from Lumen's own model host, which is not set up
yet; until then *add niqqud* says the model is not available, and
*remove niqqud* works as usual.

## Measured

On the dev split of the `nikud` golden set, with
`node scripts/golden/evals/nikud.mjs --dev --model Nakdimon.onnx`:

| Part | Sentences | Words fully right | Letters with a wrong mark |
|---|---|---|---|
| Modern (Nakdimon's own held-out test texts) | 10 | 93.6% | 2.8% |
| Classical (Ben-Yehuda: poetry, liturgy) | 15 | 54.9% | 21.3% |
| Letters unchanged (all) | 25 | 100% | — |

Nakdimon is trained on modern Hebrew; classical and poetic text needs the
larger "high quality" model, which is not part of Lumen yet.
