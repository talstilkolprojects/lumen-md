---
title: Hebrew and right-to-left
description: Writing in Hebrew (and Arabic) in Lumen — direction per line, the interface in Hebrew, search that ignores niqqud and prefixes, spelling on this device, and exports that keep the direction.
---

Lumen is built for notes that mix Hebrew and English.

## The interface

`⌘K → Language: …` switches the interface. Hebrew and Arabic flip the
whole layout (sidebar, menus and dialogs mirror). The interface is in 8
languages: English, Hebrew, Arabic, Russian, French, German, Japanese and
Chinese.

## Direction in a note

- **Per line, automatically.** In the source editor each line takes its
  direction from its first strong letter: a Hebrew paragraph aligns right,
  an English one left, and the cursor and selection follow. Code blocks
  and the front matter are always left-to-right.
- **For a whole note:** put `dir: rtl` (or `ltr`) in its front matter.
- **For the editor:** `⌘K → Text Direction: RTL (Right to Left)` (and back
  with *Text Direction: LTR*).

## Search

Workspace search folds niqqud, final letters (ם/מ, ן/נ…) and the prefix
letters ו ה ב כ ל מ ש, so *בבית*, *והבית* and *הַבַּיִת* all find *בית*.
The exact form ranks first. See
[Workspace search](/workspace/search/). Links between notes and heading
anchors compare names the same way, so `[[שלום]]` finds *שָׁלוֹם.md*.

## Spelling, on this device

Hebrew paragraphs are checked **locally**: a final letter inside a word, a
repeated word, a space before punctuation. For spelling against a
dictionary, download Hspell's word list once with
`⌘K → Hebrew spelling: dictionary (download / remove)` (5.7 MB). It
is AGPL-3.0, so it isn't bundled; it is stored on this device, and the
same command removes it. Turn the check on with
`⌘K → Enable grammar check (LanguageTool)`. **Hebrew text never goes to
LanguageTool**: only paragraphs that are mostly Latin are sent, with any
Hebrew words in them blanked out.

## Exports

Exports keep the direction: Word (.docx) marks Hebrew paragraphs and runs
as right-to-left, and an exported HTML file opens right-to-left when the
note is Hebrew (or its front matter says `dir: rtl`).
