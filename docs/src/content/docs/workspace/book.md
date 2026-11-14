---
title: Writing a book
description: Chapters as notes in order, word goals per chapter and per book, today's words and a streak, and the book assembled into a Hebrew EPUB 3 and a print-ready PDF.
---

A book in Lumen is a folder of notes, one per chapter, and an **index
note** that lists the chapters in order. The index uses the format of
Obsidian's [Longform](https://github.com/kevboh/longform) plugin, so the
same book opens in Obsidian too.

## Start a book

Open any note in the folder and run **Book: chapters, goals and export**
from the command palette (`⌘K` / `Ctrl+K`). When the note is not in a book
yet, Lumen offers to make one: it asks for the title and writes an index
note whose chapters are the folder's notes, in name order (`01`, `02`, …
sort as numbers). **Book: add this note as a chapter** adds the open note to
the end of the book whose index is in the same folder.

The index note looks like this:

```yaml
---
longform:
  format: scenes
  title: The Orchard
  sceneFolder: /
  scenes:
    - Opening
    - - A scene inside the opening   # a nested list: parts of a chapter
    - The second chapter
word-goal: 80000   # the book's goal
daily-goal: 500    # words a day, for the streak
author: Noa Cohen
lang: he
---
```

A chapter's own goal is `word-goal:` in the chapter's frontmatter.
Lumen's keys sit outside `longform:`, which Longform rewrites.

## The book panel

The panel lists the chapters in order with their word counts and goals,
the book's total against its goal, the words written today and the
streak (days in a row on which the daily goal was met). Drag a chapter,
or use its ↑ ↓ buttons, to reorder; only the `scenes:` list in the index
changes. A nested part moves with its chapter. Click a chapter to open it.

Today's words are the book's total now minus its total at the end of the
last day you wrote, so deleting counts against the day. The totals are
kept in a small hidden file next to the index
(`.<index name>.lumen-book.json`, which Obsidian does not show).

### How words are counted

Only prose counts: frontmatter, code, comments (`%% … %%`), link targets,
embeds and Markdown marks do not. A Hebrew word with its prefixes is one
word, also when a hyphen or maqaf joins the prefix to a number or a Latin
word (`ה-CNN`, `ב־1948`); abbreviations with geresh or gershayim (`צה״ל`,
`מס׳`) and maqaf compounds (`בית־ספר`) are one word each. A spaced dash is
not a word.

## EPUB

**Export EPUB** writes `<title>.epub`: a title page, a table of contents,
one file per chapter, the book's font (Frank Ruhl Libre, SIL Open Font
Licence) and the images the chapters show. A Hebrew book opens from the
right in Apple Books, Kindle and other readers
(`page-progression-direction="rtl"`, `dir="rtl"` and `lang="he"` on every
page); an English chapter inside it reads left to right. Links to other
notes become plain text (they lead nowhere in a book); links to the web
stay. The book keeps the same identifier across exports, so a reader keeps
your place and highlights.

## Print and PDF

**Print / PDF** opens the book in a print window; choose **Save as PDF**
in the print dialog. Pages are A5 with the chapter title on a new page,
page numbers at the bottom (none on the title and contents pages), the
paragraph indent of a printed book and Hebrew right to left.

## How it was checked

- `src/__tests__/bookMode.test.ts`: the word count rules, the index (read,
  reorder, add, comments and CRLF kept), progress, the streak, and a
  30-chapter book counted in well under 10 seconds.
- `src/__tests__/bookEpub.test.ts`: the package structure (stored
  `mimetype` first, RTL spine, navigation, font, images), well-formed XHTML
  chapters, 30 chapters assembled in well under 10 seconds, and the print
  document.
- A 30-chapter Hebrew book with footnotes, a table, code and an English
  chapter, assembled in a browser (0.3 s): **epubcheck 5.3.0 — 0 errors,
  0 warnings**; its PDF has 62 A5 pages with Frank Ruhl Libre embedded.

Not yet checked by hand: opening the EPUB in Apple Books and Kindle
Previewer.
