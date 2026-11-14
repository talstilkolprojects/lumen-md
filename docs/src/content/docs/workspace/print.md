---
title: Print and PDF
description: Print a note or save it as a PDF the way a word processor would, with page numbers (Hebrew numerals too), a header and footer, a table of contents, clean page breaks and embedded fonts.
---

**Print / Save as PDF…** (in the File menu and the command palette) opens the system print dialog. Choose "Save
as PDF" to get a file. The layout is built for paper, and for Hebrew first.

## What you get

- **Direction and language from the note.** A Hebrew note prints right to
  left, even from the English interface. Because the language is set
  correctly, the PDF's text can be searched and copied.
- **Header:** the note's title on every page except the first.
- **Footer:** "page / pages", as `1 / 5` or in Hebrew numerals `א / ה`.
- **Clean page breaks.** A heading never sits alone at the bottom of a page.
  Tables, rows, images, code blocks, callouts and display math are never
  split. A long table repeats its header row on every page.
- **Forced breaks:** a paragraph that is just `\newpage` or `\pagebreak`.
- **Embedded fonts.** The app's own OFL fonts (Heebo and Frank Ruhl Libre
  for Hebrew, Inter and Source Serif 4 for Latin) are embedded in the PDF,
  so it looks the same on any computer.
- **Light theme on paper,** whatever theme the screen uses.

## Settings, per note

Put these in the note's frontmatter:

```yaml
---
toc: true              # a table of contents (h1–h3) on the first page, with working links
page-numbers: hebrew   # decimal (default), hebrew or none
header: Quarterly memo # header text; "" for none
footer: Confidential   # text before the page number
page-size: Letter      # A4 (default) or Letter
---
```

## On a phone or tablet

The same command works in mobile browsers and in the installed app. When the
browser blocks the print window, as installed apps and iOS do, Lumen prints
from the current page instead.

## Limits

- **Footnotes print at the end of the note,** not at the bottom of each
  page. Chromium's print engine has no per-page footnotes.
- **The table of contents has no page numbers.** Its entries are links,
  which still work in the PDF.
- **Copying from the PDF:** Hebrew and English words copy in reading order.
  A number with a punctuation mark right next to it inside Hebrew text
  (`1:`) can come out of some PDF readers swapped (`:1`). This happens in the
  PDF's text layer, not in what is printed.

## Tested

Ten golden notes are printed on every test run: a Hebrew report, a long
table, a table of contents, footnotes, callouts, code and math, images,
page breaks, an English Letter memo and nested lists. Each is compared with
an approved image (under 1% of pixels may differ). Each PDF's text is also
read back with `pdftotext` to check the reading order, the page numbers and
the embedded fonts.
