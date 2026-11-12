---
title: Arabic (beta)
description: Write Arabic next to Hebrew and English in one note. Each line takes its own direction, tashkeel can be hidden or removed, search ignores it, and Arabic spelling runs on this device.
---

Lumen treats Arabic the way it treats Hebrew. Arabic is still marked
**beta** in the language picker: the interface strings were machine-translated
and wait for a native speaker's review ([help translate](../../contributing/translations/)).

## Arabic, Hebrew and English in one note

Each paragraph, heading, list, quote and table cell takes the direction of its
own first letter. An Arabic paragraph runs right to left, the English one under
it left to right, and a Hebrew one right to left. This works the same in the
editor, the preview, WYSIWYG and the exports. Code always runs left to right,
even with an Arabic comment.

## Tashkeel

- **Hide or show Arabic tashkeel** (`⌘K`) hides the harakat, tanwin, shadda
  and sukun in the editor and keeps the letters. The note keeps every mark:
  copying, saving and exporting are not affected. Run the command again to
  show them.
- **Remove Arabic tashkeel (selection or note)** removes the marks from the
  selection, or from the whole note when nothing is selected. It is one change,
  so `⌘Z` brings them back.

## Search

Search ignores tashkeel and tatweel, and treats the spellings writers use
interchangeably as the same: أ إ آ and ا, ى and ي, ة and ه. A search for
`مدرسة` also finds `والمدرسة`, `للمدرسة` and `بالمدرسة`, because the
conjunctions, prepositions and the article are set aside. Hebrew and English
in the same vault are searched as before, in one query.

## Spelling

Arabic paragraphs are checked on this device and are never sent to a spelling
server. Arabic words inside an English paragraph stay on this device too.

- **Always on:** a word typed twice, a space before punctuation, and Latin
  punctuation after an Arabic word (`,` `;` `?` where Arabic uses `،` `؛` `؟`).
- **Spelling words:** run `⌘K → Arabic spelling: download or remove the word list`.
  It downloads Ayaspell's word list once from GitHub and keeps it on this
  device. Ayaspell is licensed GPL / LGPL / MPL, so it is not built into
  Lumen, which is MIT. Run the same command again to remove it.

Words are checked without their tashkeel, conjunctions, prepositions, article
and common endings, and with the same folding as search.

## Measuring it

`eval/arabic-spell/errors.json` holds 200 misspellings of 100 common words.
`node scripts/eval-arabic-spell.mjs <index.dic>` reports how many of them the
checker catches (the target is 70 %) and how many correct words it wrongly
marks.
