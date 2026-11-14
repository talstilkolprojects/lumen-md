---
title: EPUB reader and reading mode
description: Read EPUB books in the vault (Hebrew right-to-left included), highlight them like PDFs, and read clipped pages in a calm reading mode.
---

Lumen opens EPUB books from your vault in a reader of its own. Your books,
their fonts and pictures stay on the device: nothing is fetched while you
read. A link in a book that leads to a website is shown, not opened.

## Open a book

- **Command palette** (⌘K / Ctrl+K) → **Open an EPUB for reading…** copies a
  book from your computer into the vault and opens it.
- **File tree**: click a `.epub` file.
- **A link** in a note: `[[book.epub]]`, or `[[book.epub#chapter=3]]` to open
  it at chapter 3.

The reader opens at the chapter where you stopped. **Contents** shows the
book's table of contents. The arrow keys go to the previous or next chapter;
in a right-to-left book they follow its direction. Hebrew and Arabic books
are shown right to left, with the book's own fonts.

## Reading settings

**Light**, **Sepia** or **Dark**, **A−** / **A+** for the text size, and
**⇥⇤** / **⇤⇥** for the line width. The settings are kept for each book (and
each note in reading mode) on this device.

## Highlights

Select text and press **Highlight** (or **H**). Highlights work like the
[PDF reader's](/workspace/pdf-reader/): each one is saved as a W3C Web
Annotation in a note next to the book, `book.epub.md`. Each highlight there
is a line with a link such as `[[book.epub#chapter=2&highlight=…]]`, which
opens the book at that chapter and flashes the highlight. Add a note to a
highlight, or remove it, under **Highlights**. Write your own notes anywhere
in `book.epub.md` outside the highlights block; Lumen only changes that
block.

## Reading mode for clipped pages

**Command palette → Reading mode** shows the open note as a page to read,
with the same themes, size and width. It is made for pages clipped from the
web: the source and the date the page was clipped are shown at the top.
Select a passage and press **Highlight** (or **H**). The passage is marked
in the note itself as `==…==`, the web clipper's highlight syntax, so the
highlight lives in the Markdown and syncs with it. A passage across
paragraphs, links or formatting can't be marked. Run the command again, or
press Esc, to leave.
