---
title: Hebrew dictation, models and accuracy
description: Which speech model Lumen uses for Hebrew in the browser and on phones, how each sentence is re-read by Whisper, and how accuracy (WER) is measured.
---

Dictation runs on your device. The audio never leaves it, unless you send
it to your own desktop over your local network (below).

## Which model, when

| Situation | Model | Size | Licence |
|---|---|---|---|
| Live dictation, while you speak | ivrit.ai Zipformer2, streaming (WASM) | 72 MB | CC BY 4.0 |
| Each finished sentence, on a GPU with WebGPU and f16 | ivrit.ai Whisper large-v3-turbo | ~563 MB | Apache-2.0 |
| Each finished sentence, without WebGPU or on a phone | none yet: the streaming text stays, or your desktop re-reads it (below) | | |
| A Hebrew audio file or recording | turbo on a strong GPU, otherwise whisper-base / small | | |

**Ozen v1 is off for now.** Its weights are Apache-2.0, but its model card
lists training audio (imvladikon/hebrew_speech_kan) that declares no
licence. Lumen only gives you a speech model whose licence is verified, so
Ozen stays off until that is cleared.

**Live dictation streams first, then corrects.** While you speak, the
streaming model shows text right away. When you pause, the audio of that
sentence goes through Whisper, and the result is inserted instead. That
happens only if it arrives within 2 seconds and reads as the same sentence.
Otherwise the streaming text stays, so a slow or confused second pass never
loses your words.

**Nothing is downloaded during dictation.** The second pass uses a model
only if it's already on your device. Transcribe one Hebrew file to get it:
turbo on a capable GPU.

## Send to my desktop

On a phone, Hebrew dictation runs the streaming model alone, and it makes
about 23.6% word errors on FLEURS-he: over the 15% target. If your phone is
linked to your desktop with [sync on the local network](/sync/lan/), the
dictation panel offers **Send to my desktop**:

- Lumen offers it only when dictation on this device is over 15% (a number
  measured on it, or else the measured number of the models it runs) and
  the desktop has a bigger model ready: Whisper in the desktop app
  ([desktop Whisper](/ai/whisper-desktop/)), or ivrit.ai turbo already in
  its browser.
- Press it, and each sentence you finish goes to the desktop, is
  transcribed there, and the text comes back into your note. The streaming
  text still appears while you speak.
- **It stays on your network.** The audio travels only over the local
  network link between your two devices (no server, no STUN or TURN, local
  addresses only, the same link the sync uses), and it is also encrypted
  with your vault's keys, so only your own devices can read it. When the
  browser doesn't tell Lumen the other device's address, the sentence isn't
  sent: an address that can't be checked doesn't count as local.
- If the desktop doesn't answer in time (10 seconds per minute of audio,
  at least 2.5 seconds per sentence), is busy or goes away, that sentence
  keeps the phone's text. You never lose words. A sentence the phone stopped
  waiting for is dropped on the desktop too, so it doesn't hold up the next one.
- The desktop's vault must be unlocked, and the phone must have unlocked
  the same vault.

## How accuracy is measured

WER (word error rate) is measured on **FLEURS-he validation**, the set
where the streaming model scores 23.6%. The target is **15% or less**.

```sh
npm run eval:asr-web -- --fleurs <folder from scripts/asr/fleurs_spike.py> --models turbo
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
