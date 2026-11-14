---
title: On-device OCR (Hebrew, English, columns)
description: How Lumen reads text from images and scanned PDF pages on your device — Latin words inside Hebrew lines, multi-column pages, and the reading order of the result.
---

When you import a scanned PDF, or an image that is mostly text, Lumen reads
it **on this device** with Tesseract (LSTM, `tessdata_fast` Hebrew and
English models that ship with the app). No image leaves the device and OCR
makes no outside request.

## Latin words inside Hebrew lines

Hebrew text is full of foreign terms: `ב-Zoom`, `קובץ ה-PDF`,
`info@example.org`, `ו-Bluetooth`. A plain Hebrew+English OCR pass gets
these wrong in typical ways:

- the Hebrew prefix glued to a Latin word is read as a Latin symbol
  (`ו-Bluetooth` → `Bluetooth-1`), and the line comes out in visual order;
- the Latin word after a prefix is read as Hebrew shapes
  (`ו-Bluetooth` → `ו-ח01סז6טו8`);
- a short Hebrew word between Latin words is read as Latin (`או` → `IN`).

Lumen fixes only the lines that need it, from the recogniser's own word and
letter boxes: the doubtful word is read again with a Hebrew-only or
Latin-only pass, a reading is kept only when it is a real word (a Hebrew
reading with digits among the letters, or a final letter inside the word,
is not), and the line is rebuilt in **logical order** — right to left, each
left-to-right run (`Google Drive`) read left to right, the prefix before
the whole run (`ב-Google Drive`).

## Columns and reading order

On a page with two or three columns the recogniser may list the left
column first, run a line across the gap between columns, or put a heading
that spans the page between them. Lumen orders the lines from their boxes:

1. a line that crosses a column gap is cut there;
2. the page is split into bands (a heading, the columns, a footer), top to
   bottom;
3. inside a band, columns are read **right to left** on a Hebrew page (left
   to right on an English one), each top to bottom.

The text you get — in a note, or copied from a scanned page — follows that
order.

## Text layer of a scanned page

Each recognised line keeps its box, so a scanned page can carry an
invisible, selectable text layer over the image: one span per line, in
reading order, holding the line's logical text with its direction. Selecting
and copying Hebrew from the page then gives the words in the order they are
read, not the order of the glyphs on screen.

## How it is measured

The Hebrew OCR golden set (`eval/golden/ocr-he`) has rendered lines and
pages in six fonts, clean and degraded, and a part of 20 mixed-script pages in
two or three columns. The CI measurement (`OCR_CER=1`,
`e2e/ocr-cer.spec.ts`) gates the character error rate per script (clean
≤ 5 %, degraded ≤ 12 %) and, on the column pages, the share of lines whose
words come out in reading order (≥ 95 %).

## Limits

- Handwriting and very low-resolution photos are out of scope.
- Narrow columns in a serif face are the hardest case: the recogniser can
  drop words there, and no reordering brings them back.
- Nikud is not read reliably; pointed lines are reported, not gated.
