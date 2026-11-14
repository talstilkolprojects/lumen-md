---
title: Reading aids
description: Niqqud for reading that never changes the note, a dyslexia-friendly layout, and read-aloud that highlights each word.
---

Open the command palette (**⌘K / Ctrl+K**) and run **Reading aids…**. Everything here
changes how a note *looks or sounds*; nothing here changes the note or its file.

## Show niqqud (display only)

**Show niqqud (display only)** — in the palette, or the first switch in Reading aids —
adds vowel points to the Hebrew in the preview, for reading. The note, the editor and
the file on disk stay byte for byte as written (a test checks the bytes before and after).

- Niqqud is added **on this device** by the Nakdimon model (MIT), the same one as
  **Add niqqud**. It asks before downloading the model the first time.
- Code, keyboard keys, math, text marked `data-no-nikud` and any editable surface (the
  WYSIWYG editor) are never pointed. Text you pointed yourself keeps your niqqud.
- A result that would change a letter is never shown: only the same letters with marks
  added.
- It lasts for this session; run the command again to hide it. To write niqqud into the
  note, use **Add niqqud** instead.

## Dyslexia-friendly layout

Turn on **Use the dyslexia-friendly layout**. It applies to the preview and to the
editor's text, and is remembered on this device.

| Setting | Default | Why |
|---|---|---|
| Letter spacing | 0.12 em | Extra letter spacing helped dyslexic children read faster and more accurately (Zorzi et al., *PNAS* 2012). 0.12 em is the WCAG 2.2 text-spacing value (SC 1.4.12). |
| Word spacing | 0.16 em | WCAG 1.4.12; the British Dyslexia Association style guide asks for wide word spacing. |
| Line spacing | 1.8 | The BDA guide asks for at least 1.5. |
| Line focus | on | The paragraph under the pointer or the line with the cursor is highlighted, with a bar at its start as well as a colour. |
| Page colour | cream | The BDA guide recommends off-white or pastel backgrounds. Every tint keeps body text at 7:1 contrast or more, light and dark. |

### Fonts

| Choice | Hebrew | Latin | Licence |
|---|---|---|---|
| The app's font | Heebo | Inter | OFL 1.1 |
| Noto Sans Hebrew (default) | Noto Sans Hebrew | the app's | OFL 1.1 |
| OpenDyslexic | Noto Sans Hebrew | OpenDyslexic | OFL 1.1 (Reserved Font Name) |

There is no openly licensed font made for dyslexic readers of Hebrew, so the default is a
plain sans-serif with distinct letter shapes whose marks sit where they belong.
OpenDyslexic has no Hebrew letters; it is offered for Latin text because some readers
prefer it, though studies did not find it faster than a plain sans-serif (Wery &
Diliberto 2017; Kuster et al. 2018). The faces are downloaded from Lumen's own site when
you first choose them (never from a font service), then work offline.

## Read aloud with the word highlighted

**Read aloud** reads the note with your system's voices — on macOS, Windows, iOS and
Android that includes Hebrew. The sentence being read is highlighted in the editor, and
inside it **the word being spoken**, with an underline as well as a colour. Set the speed
in Reading aids.

- Only voices that run on this device are used, unless you allowed network voices (and
  never under the local-only AI policy).
- Word highlighting needs a voice that reports word boundaries. Most system voices do; if
  yours does not, only the sentence is highlighted.

## Not verified yet

The plan asks for a reading test with three readers with dyslexia (W4.25): reading speed
with the aids on must be the same or faster. That test has not been run yet.
