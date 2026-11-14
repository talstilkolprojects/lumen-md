---
title: Export and import
description: Take the whole vault out as a .zip or a folder, bring in an Obsidian vault or a Notion export, and convert single files to and from many formats.
---

Your notes are plain Markdown, and they can always leave Lumen.

## The whole vault

**Export:** `⌘K → Export the whole vault…`. Pick a **.zip** download or,
where the browser can write folders (Chrome, Edge), a **folder**. Every note
and attachment is written with its folder path. A folder export goes into
a new `lumen-vault-<date>` subfolder, so nothing already in the folder you
picked is overwritten. The note you are editing is saved first.

**Import:** `⌘K → Import notes (zip / folder: Obsidian, Notion, Lumen)…`.
Pick a .zip or a folder. Lumen recognises:

| Source | Recognised by | What import does |
|---|---|---|
| Obsidian vault | an `.obsidian/` folder | notes and attachments as they are; `.obsidian/` itself is skipped |
| Notion export | most file names end in Notion's 32-character ID | IDs are removed from the names, and the links between pages are rewritten to the new names |
| Lumen export, or any folder | otherwise | everything as it is |

Everything is imported into a **new folder** (`Imported/<name>`, numbered
when that name is taken), so no existing note is ever overwritten. Two
pages that end up with the same name are numbered (`Page 2.md`).
`.git`, `.trash`, `__MACOSX` and `.DS_Store` are skipped. When the import
finishes, a message says how many notes and files came in and where.

## One document

**Out:** the *File* menu and the palette export the open note to HTML,
Word (.doc), RTF, LaTeX, reStructuredText, AsciiDoc, Org-mode, OPML,
slides (Reveal.js), EPUB, Jupyter (.ipynb), PowerPoint (.pptx), a static
site, and PDF (`⌘K → Print / Save as PDF…`). Right-to-left text keeps its
direction in the exported files.

**In:** open a file (`⌘O`) or drop it on the window. Besides Markdown and
text, Lumen converts HTML, RTF, CSV / TSV, JSON, XML, Word (.docx and the
older .doc), OpenDocument (.odt), PowerPoint (.pptx), Excel (.xlsx),
EPUB, PDF (with OCR for scanned pages), MHTML, OPML, LaTeX,
reStructuredText, AsciiDoc, Org-mode, Jupyter notebooks, Apple Pages /
Numbers / Keynote, Fountain screenplays and .zip archives into a Markdown
note.

## How it is tested

The vault round trip (export, then import), the Obsidian and Notion
detection, Notion's link rewrite and the duplicate-name numbering are unit
tests over `src/storage/exportAll.ts`. Each format converter has its own
tests.
