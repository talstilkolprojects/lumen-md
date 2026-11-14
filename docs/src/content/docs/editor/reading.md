---
title: Reading options and Hebrew fonts
description: Choose the Hebrew font, size, line height and column width of the preview — for every note or one note — with spaced Hebrew and a dyslexia-friendly font for English. Fonts download only when chosen, from the app itself.
---

**View → Reading options…** (or the command palette) sets how the preview
reads.

- **Apply to**: every note, or this note only. A note with its own settings
  keeps them when it is renamed. Choosing "every note" again drops them.
- **Hebrew font**: the app's own font, Heebo, Frank Ruhl Libre, Noto Sans
  Hebrew, Noto Serif Hebrew, Assistant or David Libre. A sample verse with
  nikud and cantillation marks shows the font before you read with it.
- **Text size, line height, column width**.
- **Spaced Hebrew**: more room between words and letters, and taller lines
  so that nikud above and below has room.
- **Dyslexia-friendly font for English text** (OpenDyslexic). It applies to
  Latin letters only; Hebrew keeps its own font.

## Privacy, size and offline

| Font | Licence | Download |
|---|---|---|
| Heebo, Frank Ruhl Libre | SIL OFL 1.1 | none (the app's interface fonts) |
| Noto Sans Hebrew | SIL OFL 1.1 | 29 KB |
| Noto Serif Hebrew | SIL OFL 1.1 | 32 KB |
| Assistant | SIL OFL 1.1 | 25 KB |
| David Libre | SIL OFL 1.1 | 50 KB (regular + bold) |
| OpenDyslexic | SIL OFL 1.1 | 207 KB (regular + bold) |

- No font is in the startup bundle or the offline precache. A font is
  downloaded the first time you choose it, from the app's own address and
  never from a font service, so no third party learns what you read. After
  that it is cached and works offline.
- All of them together are 0.34 MB of WOFF2 (the budget is 1.5 MB).
- The Hebrew files are subsets: Hebrew with every point and cantillation
  mark, the presentation forms, Latin-1 and punctuation, with every OpenType
  layout feature kept. `scripts/reading-fonts.sh` rebuilds them from
  upstream.
- OpenDyslexic has a Reserved Font Name, so its files are the upstream ones,
  unchanged. The licences are in `public/fonts/reading/OFL-*.txt`.

## Nikud

Nikud stays in place only when the font positions each mark against each
letter (OpenType mark-to-base anchors); otherwise vowels collide with the
letter or with each other. `src/__tests__/readingFonts.test.ts` reads each of
the five fonts (Noto Sans and Serif Hebrew, Frank Ruhl Libre, Assistant,
David Libre) and checks that every point is anchored to every letter that
takes points. `e2e/reading-fonts.spec.ts` renders a verse in every font and
attaches the pictures for a visual check.

## Limits

- Assistant, David Libre and Heebo have no meteg (U+05BD); the browser draws
  it from the next font in the list.
- Frank Ruhl Libre has no mark anchors on final mem, nun and tsadi (ם ן ץ),
  which take no points in standard Hebrew.
- OpenDyslexic has no Hebrew letters, which is why it applies to English
  text only.
