---
title: All highlights
description: Every highlight from PDFs, books and clipped pages in one place: search them, tag them, export them to a note with links back, or drag one into a note.
---

**Command palette → All highlights** lists every highlight in your vault:

- from **PDFs**, kept in `file.pdf.md` ([PDF reader](/workspace/pdf-reader/)),
- from **EPUB books**, kept in `book.epub.md` ([EPUB reader](/workspace/epub-reader/)),
- from **clipped pages**: passages marked `==like this==` in a note that was
  clipped from the web, or marked in [reading mode](/workspace/epub-reader/#reading-mode-for-clipped-pages).

## Find

Type in the search box to search the highlighted text, its note and its tags.
Case, spacing and Hebrew niqqud don't matter. Narrow the list by **kind**
(PDF, EPUB, clips), by **document** and by **tag**. Click a highlight to
open it: the reader opens at its page or chapter and flashes it.

## Tags

Type a tag under a PDF or EPUB highlight and press Enter. The tag is saved
with the highlight in its note (`file.pdf.md` or `book.epub.md`), as a W3C
Web Annotation tag, so it syncs with the note. **×** removes it. A clip's
highlights show the clip's own `tags:` from its front matter.

## Scan highlights from a printed book

In **All highlights**, choose **Scan a page**. Take a photo of the page with the phone's camera,
or drop or paste an image on the desktop.

- Lumen finds highlighter in **yellow, green, pink, orange or blue**, and **pen underlines**.
  The photo is checked by colour and by the shape of a drawn line, on this device.
- Only the marked lines go through the on-device OCR (Hebrew and English, mixed lines
  included). A word broken with a hyphen at the end of a line is joined again; a highlight
  that runs over several lines becomes one highlight.
- The page number is read from the page's header or footer when it is printed there; you can
  type or change it.
- Type the book's title and author (and its ISBN if you like; the check digit is verified).
  The highlights join that book's note in the `Highlights/` folder, with `p. N`, next to
  highlights imported from Kindle, Kobo, Readwise or Zotero for the same book.

The photo is **not kept** unless you tick **Keep the photo in the vault**; then it goes to
`Highlights/scans/`. Nothing is sent over the network: the detection and the OCR models are
part of the app.

## Export and drag

**Export to a note** writes the current list to a new note,
`Highlights <date>.md`: a section per document, each highlight as a quote with
its note, its tags and a link that opens it again.

Drag a highlight into a note or a canvas: it drops as a quote with that link.
