---
title: Pasting from Word, Google Docs and the web
description: Paste from Word, Google Docs, Wikipedia, news sites or Gmail, in Hebrew or English, and get clean Markdown that keeps the structure and drops the styling.
---

Most text reaches a note by pasting. Lumen turns what the clipboard holds
into clean Markdown, in both editors.

## What is kept

- Headings, including Word's Title and Heading styles.
- Bulleted and numbered lists, nested lists included. Word and Google Docs
  write lists in their own ways (Word as indented paragraphs, Docs as one
  flat list per level), and Lumen rebuilds them as real nested lists.
- Tables, with each cell's bold, links and line breaks.
- Links and images.
- Bold, italic, strikethrough and code. Google Docs marks these with
  styles, not tags, and Lumen reads the styles.
- Quotes, including the quoted reply in a Gmail message.

## What is dropped

- Every inline style: fonts, sizes, colours, margins and alignment. A note
  never gets `style=` from a paste.
- Direction attributes (`dir`). Each paragraph finds its own direction, so a
  Hebrew paragraph sits on the right and an English one on the left.
- Invisible direction characters (LRE, RLE, PDF, LRO, RLO, the isolates, and
  doubled marks). An LRM or RLM is kept only where it decides the order of
  the text right after it, such as `שלום‎ (2)`.
- Site clutter: scripts, forms, Wikipedia's edit links and citation
  markers, and email signatures.

## Two ways to paste

| | Source editor | WYSIWYG |
|---|---|---|
| **Ctrl+V / ⌘V** | HTML with structure becomes Markdown. Code copied from a code editor stays plain text. | The cleaned HTML becomes headings, lists and tables. |
| **Paste as plain text** (command palette) | The clipboard's text, as is | The clipboard's text, as is |
| **Paste with formatting** (command palette) | Always converts the HTML | Always converts the HTML |

The palette commands read the clipboard, so the browser may ask for
permission the first time.

## Tested

Thirty clipboard samples are converted on every test run, each checked
against its expected Markdown. They cover Word, Google Docs, Wikipedia
(English and Hebrew), a Hebrew news site and Gmail, in Hebrew, English and
mixed text. The run also checks for zero inline styles and zero needless
direction marks.

A second set is a real corpus (`src/__tests__/fixtures/real-corpus`): the
same thirty Hebrew-first documents as Google Docs and Word put them on the
clipboard, as LibreOffice Writer does, and as the text a PDF reader copies
(pdf.js and poppler) out of the PDF LibreOffice printed. All 150 paste
whole: headings, nested lists, tables, links, images and right-to-left
text. Text pasted from a PDF reader loses the invisible direction
embeddings some readers add to each line.
