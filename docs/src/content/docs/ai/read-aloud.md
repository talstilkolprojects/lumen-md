---
title: Read aloud (Hebrew included)
description: Listen to a note on this device — the word being read is highlighted, the position is kept, and you choose the speed and voice.
---

**Command palette → Read aloud** reads the open note on this device. Run it
again to stop. This works for articles you clipped, too: open the note and
listen.

- **What is being read is highlighted**: the sentence, and the word when the
  voice reports where each word starts (most system voices do). The
  highlight is a mark, not a selection, so you can keep typing.
- **It continues where you stopped.** Stop in the middle, run it again later,
  and it resumes at the same sentence, even if you edited the note. After the
  last sentence the next run starts from the top.
- **Speed and voice**: *Command palette → Read aloud: voice and speed…*. Pick
  the speed (0.75× – 2×) and, when your system has more than one voice for
  the note's language, which one to use. A ☁ next to a voice means the
  system streams it from the internet; the others run on the device.
- Code blocks, front matter and link addresses are skipped. Each sentence is
  read in its own language: a Hebrew sentence with the Hebrew voice, an
  English one with the English voice.

## Listening to a PDF

In the [PDF reader](/workspace/pdf-reader/), **Read aloud** in the toolbar
reads the PDF with the same voice, speed and saved position, and the view
follows the page being read ("Reading page 3"). Press it again to stop, or
close the PDF. Before reading, Lumen joins the lines of each paragraph,
mends words hyphenated across lines, and puts Hebrew that the PDF stored in
visual order back in reading order. A scanned page has no text until you
recognise it (OCR on the page).

## Hebrew voices

Hebrew is read with **your system's Hebrew voice** (on macOS, Windows and
Android). If there is none, Lumen says so; add one in the system's speech
settings.

Lumen also has an on-device **neural** Hebrew reader. It adds niqqud
([Hebrew niqqud on this device](/ai/nikud/)), turns the pointed text into
phonemes with Lumen's own Hebrew rules, and plays them with a Piper-format
voice. It is **not active yet**: every public Hebrew voice is trained on
recordings that may not be used commercially, so none can ship. Once a voice
with a licence that allows it exists, it is listed in the licence gate,
downloads once with your consent, and Hebrew notes are read with it. After
that download, reading needs no network.

Everything but the voice is ready for it:
- **Numbers are read out** in Hebrew words with their vowels: "15" as
  חֲמֵשׁ עֶשְׂרֵה, "ב-2025", "3.5%", "-7", "14:30". Prefixes are said the
  way people say them ("be-alpayim"), and long digit strings are read digit
  by digit.
- A candidate voice is checked before it is listed:
  `npm run tts:voice -- check <voice.onnx.json>` says whether it has every
  sound Lumen's Hebrew rules write. `npm run tts:voice -- pin …` also
  checks:
  - the licence of the weights **and** of the training data: no
    non-commercial, no-derivatives or GPL terms, and nothing on the
    licence gate's deny-list;
  - that both files are pinned to a fixed revision.

  It then prints the two entries to add, with the files' sizes and
  sha256.

## Listening test (developers)

The read-aloud quality target is an average score (MOS) of at least 3.8 out
of 5, from 5 listeners on 20 everyday sentences (`eval/listening/tts-he.json`).

```sh
npm run tts:mos -- sheet --raters dana,yossi,noa,eli,maya   # score sheet + a note to read aloud
npm run tts:mos -- score tts-ratings.csv                       # MOS, 95% interval, per sentence and listener
```
