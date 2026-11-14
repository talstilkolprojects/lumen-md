---
title: PDF reader and highlights
description: Read PDFs in the vault, highlight text (Hebrew included), and keep every highlight as a W3C Web Annotation in a Markdown note that links back to the page.
---

Lumen opens a PDF from your vault in a reader of its own. You can select
text on a page and highlight it, add a note to a highlight, and search the
whole document. Every highlight is saved in an ordinary Markdown note next
to the PDF, with a link that opens the PDF at that page and flashes the
highlight.

Everything happens on your device. The PDF is never uploaded.

## Open a PDF

- **Command palette** (⌘K / Ctrl+K) → **Open a PDF for reading…** copies a
  PDF from your computer into the vault and opens it.
- **File tree**: click a `.pdf` file in the vault.
- **A link** in any note: `[[paper.pdf]]`, or `[[paper.pdf#page=3]]` to
  open it at page 3.

Pages are rendered only when they come near the screen, so long documents
open quickly. Use **−** / **+** / **Fit width** to zoom, and type a number
in the page box to jump to a page.

## Highlight text

1. Select text on a page.
2. Press **Highlight**, or the **H** key.

The highlight appears over the words and in the **Highlights** list on the
side. Write in the box under a highlight to add a note; it is saved when
you leave the box. **Delete** removes the highlight.

Highlights work the same in right-to-left text: select Hebrew words and the
highlight covers exactly those words on the line.

## The highlights note

The highlights of `paper.pdf` are kept in `paper.pdf.md`, in the same
folder. **Open the notes** in the reader opens it. It holds a readable list:

```markdown
- [[paper.pdf#page=3&highlight=1a2b3c4d|p. 3]] “the sentence you highlighted” — your note
```

Click a link in the preview and the reader opens at that page and flashes
the highlight.

Below the list there is a fenced `json lumen-pdf-annotations` block with
the highlights as [W3C Web Annotations](https://www.w3.org/TR/annotation-model/):
a `FragmentSelector` for the page (`page=3`, in the
[RFC 3778](https://www.rfc-editor.org/rfc/rfc3778) form PDF links use),
refined by a `TextQuoteSelector` (the exact text, with a little of the text
before and after it) and a `TextPositionSelector`. Other annotation tools
can read them.

Lumen only rewrites the part of the note between the
`lumen:pdf-annotations` markers. Anything you write above or below them is
kept.

### When the PDF's text changes

A highlight is found again by its quote, not by its position. If the text
on the page moved, was split into lines differently, or a few characters
changed (a re-saved file, a newer PDF engine), the highlight still lands on
the right words. If the text is gone, the highlight stays in the list with
a note that its text wasn't found.

## Search

Type in **Search in this PDF** and press Enter; Enter again goes to the
next match, Shift+Enter to the previous one. Search ignores case, extra
spaces and Hebrew vowel marks (niqqud). ⌘F / Ctrl+F jumps to the search box
while the reader is open, and Esc closes the reader.

## Scanned pages

A page that is only an image has no text to select. The reader says so and
offers **Recognise text (OCR)**; **Recognise scanned pages** in the toolbar
does every such page of the PDF, one after another. The text is recognised
on your device (Hebrew and English, the same OCR as image import) and laid
over the page image as an invisible text layer, line by line where the
words are: you select it, search it and highlight it on the page itself,
like a page that has text.

What OCR found is kept on this device for the next time you open the same
PDF (even under another name), so the highlights you made on a scanned page
are back without running OCR again. In an [encrypted vault](/security/vault-encryption/)
it is encrypted like the rest of what Lumen keeps in the browser, and
nothing is written while the vault is locked.

Measured on 20 scanned Hebrew pages (printed to PDF, rasterised with
poppler, skewed, blurred and speckled like a desk scan; made by
`scripts/ocr/scanned-he/make.mjs`), the OCR got 12.2% of the characters
wrong, and a highlight of a phrase landed on it on all 20 pages. Search on a
scanned page is forgiving: when nothing matches exactly, it also finds a
phrase of 8 or more characters that OCR read with a letter or two wrong
(about 15% of the characters), and it treats Hebrew final letters like their
plain forms. Check recognised text against the image before quoting it.

## Reading mode

**Reading mode** in the toolbar shows the pages alone, fitted to the width,
without the highlights panel; the pages scroll one after another. Press it
again to come back.

Wherever you stop, Lumen remembers the place: the page and how far down it
you were, not pixels, so a phone and a desktop at different zooms open the
same line. It is kept in the vault (`.lumen/reading-positions.json`), so it
travels with the vault's sync; when two devices read before syncing, each
PDF keeps the place saved last. A link to a page or a highlight still opens
there.

## Send highlights to Zotero

When the PDF is an attachment in your Zotero library (synced from
zotero.org, see [Citations](/editor/citations/)), **Send to Zotero** in the
highlights panel adds your highlights to it as Zotero annotations: the
quoted text, your note, the page and where on the page, so Zotero's PDF
reader shows them in place.

- Nothing is sent before you confirm a dialog that names the item and how
  many highlights go. It is the only thing Lumen writes to Zotero.
- It uses the same API key as the library sync, from this device's secret
  store. The key needs **write access** (zotero.org → Settings → Security →
  Applications); a read-only key is refused before anything is sent.
- Each highlight is sent once (Lumen remembers which went, in
  `.lumen/zotero-annotations.json`); edits made afterwards stay in Lumen.
- The requests go only to api.zotero.org and appear in the privacy ledger; a
  local-only privacy policy blocks them.
- The PDF is matched to its Zotero attachment by file name. If that is not
  unique, add `zotero-attachment: KEY` (the attachment's 8-character key) to
  the front matter of the highlights note.

## Limits

- Highlights are made within one page; a selection that runs onto the next
  page is cut at the end of the first.
- Encrypted (password-protected) PDFs don't open.
- The PDF must be in the vault, which needs a browser with the Origin
  Private File System.
