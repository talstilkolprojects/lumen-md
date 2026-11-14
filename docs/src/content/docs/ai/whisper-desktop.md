---
title: Hebrew Whisper on the desktop
description: Transcribe long Hebrew recordings on your computer with ivrit.ai's Whisper in whisper.cpp — one sentence per line, each time a link into the audio.
---

**Command palette → 🎙 Transcribe an audio file (with timestamps).** Pick an
audio or video file. Lumen transcribes it **on this device** and inserts the
transcript at the cursor:

```md
### team-meeting.m4a

[▶ 0:00](<attachments/2026-11-10-team-meeting.m4a#t=0,6>) Good morning, everyone.
[▶ 0:06](<attachments/2026-11-10-team-meeting.m4a#t=6,14>) Today we'll go over the budget.
```

One line per sentence. Each time is a link that plays the recording from
that point. The audio is kept in `attachments/` when the workspace is
available; without one, the times are plain text.

## Which engine transcribes

| Where | Engine | When |
|---|---|---|
| Desktop app, Hebrew | ivrit.ai Whisper large-v3-turbo (ggml) in **whisper.cpp** | once it is installed (below) |
| Browser, Hebrew | ivrit.ai Whisper turbo (ONNX, WebGPU) | a GPU with f16 and enough memory |
| Anywhere | Whisper base (WASM) | otherwise, and for other languages |

Live dictation keeps the streaming Hebrew model (Zipformer): text appears
while you speak. Whisper is used for files, where accuracy matters more than
speed of the first word. For Hebrew the language is set, never guessed.

Nothing is sent anywhere. On the desktop the audio goes to a temporary file
on your computer, `whisper-cli` reads it, and the file is removed. After the
model is on disk, transcription makes no network requests.

## Setting up the desktop engine

Lumen does not bundle the model (about 1.6 GB) or the program. You install
both once:

1. **whisper.cpp** (MIT) — on macOS: `brew install whisper-cpp`, which
   provides `whisper-cli`. Lumen finds it on your `PATH`, in the app's
   `whisper` folder, or at the path in the `LUMEN_WHISPER_CLI` environment
   variable.
2. **The model file** — ivrit.ai's Hebrew Whisper large-v3-turbo as ggml
   (Apache-2.0), into the app's `whisper` folder:
   - macOS: `~/Library/Application Support/app.lumen.editor/whisper/`
   - Windows: `%APPDATA%\app.lumen.editor\whisper\`
   - Linux: `~/.local/share/app.lumen.editor/whisper/`

Lumen only uses the exact file it was built for. It checks the size and the
SHA-256 checksum before each use, and ignores any other file. If something
is missing, the command says so and uses the browser engine instead.

:::note
The model file is not pinned in this version yet: the exact Hugging Face
repository, revision and checksum still have to be filled in
(`npm run whisper:desktop -- pin` prints how). Until then the desktop engine
is not offered and files are transcribed in the browser.
:::

## Accuracy and speed (developers)

```sh
npm run whisper:desktop -- wer --split test=<folder with fleurs.json> --model <ggml file>
```

This prints WER and CER on the Hebrew test clips (FLEURS, Common Voice),
with the same normalisation as live dictation. It also prints the speed: the
real-time factor and the minutes one hour of audio takes. The targets are WER
≤ 10% on FLEURS-he test, and under 10 minutes per hour of audio on a Mac M1.
