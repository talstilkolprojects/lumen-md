---
title: The open Hebrew voice (recording kit)
description: How to record, check and train the first neural Hebrew voice released as CC0, so read-aloud in Hebrew is open to every app.
---

There is no neural Hebrew voice under a permissive licence today. MMS,
SASPEECH, Phonikud's checkpoints and ILSpeech are all non-commercial, so
Lumen's Hebrew read-aloud (W2.6) waits. This kit lets a volunteer record a
corpus that we release as **CC0**, and train a Piper voice on it.

## 1. The script

```sh
npx tsx scripts/voice-corpus/kit.mjs script commonvoice-he.txt benyehuda.txt --count 1500 > script.tsv
```

The kit keeps only sentences that can be read without guessing: Hebrew only,
4–16 words, no digits or Latin letters. It picks them to cover as many letter
pairs as possible. The sources must be CC0 or public domain, such as Common
Voice's Hebrew sentences and Project Ben-Yehuda (W7.7). 1,500 sentences make
about two hours.

## 2. Consent

Before recording, the speaker signs a release that dedicates the recordings
to the public domain under CC0 1.0. It says that anyone may use the voice for
any purpose, including commercially, and that this can't be withdrawn later.
The wording is reviewed first (W6.37).

## 3. Recording and the take check

Record one WAV per line (`wavs/he_0001.wav`, 16-bit mono, 22,050 Hz) in a
quiet room, then run:

```sh
npx tsx scripts/voice-corpus/kit.mjs check recording/
```

Each take is checked for clipping, a level that is too low or too high,
background noise (speech must be at least 35 dB above it), and a short pause
before and after the speech. Takes that pass are written in the LJSpeech
layout (`corpus/metadata.csv`, `corpus/wavs/`), and the kit reports how many
hours of good audio there are. The target is two hours.

## 4. Training

```sh
CORPUS=recording/corpus OUT=train bash scripts/voice-corpus/piper-train.sh
```

This trains with Piper (rhasspy/piper v1.2.0, MIT) on a GPU: the free one
from W6.18, or a Mac. It trains from scratch unless a checkpoint whose
weights are themselves CC0 or MIT has passed the licence gate (0.10).

## 5. The listening test

Ten raters score 30 sentences from 1 to 5 and mark mispronounced words:

```sh
npx tsx scripts/voice-corpus/kit.mjs mos ratings.csv
```

The voice ships if its MOS is at least 3.5, at most 5% of words are
mispronounced, and it runs in the browser worker at a real-time factor of 0.5
or less. The voice, the data and the code must all be CC0 or MIT.
