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
larger "high quality" model below.

## High quality: DictaBERT-char-menaked

[DictaBERT-char-menaked](https://huggingface.co/dicta-il/dictabert-large-char-menaked)
(DICTA, CC BY 4.0) is the model behind Dicta's Nakdan, the reference for
Hebrew niqqud. Lumen runs it as an int8 ONNX model in the same background
worker. When it is published on Lumen's model host, *add niqqud* offers it
first, with its own dialog (size, licence, attribution). Decline once and
this device keeps using Nakdimon. Either way, every result passes the same
letters-unchanged check before anything is written.

Until the model is exported and published, Nakdimon is used; nothing
changes in how the commands behave.

## Other readings of a word

After *add niqqud*, every pointed word remembers its next most likely
readings, as in Dicta's Nakdan:

- words the model found ambiguous get a **dotted underline** — click one to
  see its readings, with how likely each is;
- **Alt+click** any pointed word to see its readings too;
- pick a reading to replace the word; **Esc** closes the list.

The readings come from the model's own probabilities for each letter, so
they cost no second model run. Every reading keeps the word's letters.

*Add partial niqqud* points only the ambiguous words, and the same list is
there for them. Pointing only nouns or only verbs needs a part-of-speech
tagger, which Lumen does not have yet.
