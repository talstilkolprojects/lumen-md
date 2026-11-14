---
title: Hebrew dictation, models and accuracy
description: Which speech model Lumen uses for Hebrew in the browser and on phones, how each sentence is re-read by Whisper, and how accuracy (WER) is measured.
---

Dictation runs on your device. The audio never leaves it.

## Which model, when

| Situation | Model | Size | Licence |
|---|---|---|---|
| Live dictation, while you speak | ivrit.ai Zipformer2, streaming (WASM) | 72 MB | CC BY 4.0 |
| Each finished sentence, on a GPU with WebGPU and f16 | ivrit.ai Whisper large-v3-turbo | ~563 MB | Apache-2.0 |
| Each finished sentence, without WebGPU or on a phone | Ozen v1 (distilled from ivrit.ai turbo) | ~164 MB | Apache-2.0 |
| A Hebrew audio file or recording | turbo on a strong GPU, otherwise Ozen v1 | | |

**Live dictation streams first, then corrects.** While you speak, the
streaming model shows text right away. When you pause, the audio of that
sentence goes through Whisper, and the result is inserted instead. That
happens only if it arrives within 2 seconds and reads as the same sentence.
Otherwise the streaming text stays, so a slow or confused second pass never
loses your words.

**Nothing is downloaded during dictation.** The second pass uses a model
only if it's already on your device. Transcribe one Hebrew file to get it:
turbo on a capable GPU, Ozen v1 everywhere else. Without WebGPU, Ozen runs
on WebAssembly, which works on phones too.

Why Ozen v1 replaced whisper-base for Hebrew: its model card reports 8.6%
WER against 48% for whisper-base on ivrit.ai's podcast set (eval-d1), at
about the same size.

## How accuracy is measured

WER (word error rate) is measured on **FLEURS-he validation**, the set
where the streaming model scores 23.6%. The target is **15% or less**.

```sh
npm run eval:asr-web -- --fleurs <folder from scripts/asr/fleurs_spike.py>
```

This runs the same ONNX files and settings the browser uses. It's also one
step of `npm run models:day`.

The report gives two normal forms, side by side:

- **v1**: no niqqud, no punctuation, maqaf splits words, lower case.
- **v2**: v1, plus numbers count the same whether written as words or
  digits ("אלפיים ועשרים" = "2020"), "%" equals the word "אחוז", and a
  one-letter prefix on a number is its own word ("ב2020" = "ב 2020").
  Latin words are **not** transliterated ("Google" ≠ "גוגל"). That error
  stays in the score.

v2 is the headline number. v1 stays next to it, so it can be compared
with earlier runs.
