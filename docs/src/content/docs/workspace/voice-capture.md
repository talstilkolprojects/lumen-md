---
title: Voice notes into the inbox
description: Record a voice note from the capture box; it is transcribed on this device and added to inbox.md, with the recording attached if you want.
---

In the quick-capture box (⌥⌘N, or the installed app's **Quick capture**
shortcut) press **Record**, speak, and press **Stop**.

- The recording is transcribed **on this device**: by the live Hebrew
  dictation engine when it is installed (plan 6.1), otherwise by local
  Whisper after you stop. Under the **local only** AI policy nothing is
  sent anywhere — the microphone audio never leaves the browser. (The
  first transcription downloads the speech model once; after that it
  works offline.)
- The transcript lands in the box, so you can fix a word before **Add to
  inbox**. A long note gets its first 80 characters as a bold title.
- **Keep the recording** saves the audio under `attachments/`
  (`voice-YYYY-MM-DD-HHMM-<first words>.webm`) and adds a link with its
  time range, e.g. `[▶ 0:00–1:01](<attachments/…webm#t=0,61>)`.
- If no transcript can be made (no model on this device yet), the note
  is kept as audio with the text "Voice note (not transcribed)", so
  nothing you said is lost.

## One tap from the home screen

The address `/?capture=voice` opens the box **already recording**.

- **Installed app (Android, desktop):** long-press the app icon → **Voice
  note**.
- **iPhone / iPad — Shortcuts:** new shortcut → *Open URLs* →
  `https://lumen-md.vercel.app/?capture=voice` (or your own address).
  Add it to the home screen, or say its name to Siri.
- **Android home screen:** add the **Voice note** shortcut of the
  installed app to the home screen. A Quick Settings tile needs the native
  Android app (planned with the mobile builds).
