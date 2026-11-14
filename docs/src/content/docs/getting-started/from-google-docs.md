---
title: Moving from Google Docs
description: Turn Google Docs into Markdown notes in Lumen — one document, or a whole Drive folder.
---

## One document

1. In Google Docs: **File → Download → Markdown (.md)**. Older documents
   can also be downloaded as **Word (.docx)**.
2. In Lumen: open the file (`⌘O`) or drop it on the window. A `.md` file
   opens as it is; a `.docx` is converted to Markdown with its headings,
   lists, tables and images.
3. Save it into your vault.

## A whole folder

Google Takeout (takeout.google.com → **Drive**) exports a folder of
documents as `.docx`. Unzip it, and open the files in Lumen one by one, or
convert them in bulk to Markdown first and import the folder with
`⌘K → Import notes from another app (Obsidian, Notion, Evernote, Bear, Keep, Logseq, OneNote…)…`.

## What changes

| In Google Docs | In Lumen |
|---|---|
| Headings, lists, tables, links | Markdown headings, lists, tables, links |
| Comments and suggestions | not in the download; Lumen has its own [suggesting mode and comments](/collab/webrtc/) |
| Right-to-left paragraphs | detected per paragraph — see [Hebrew and right-to-left](/editor/hebrew/) |
| Sharing | Lumen is local-first; see [real-time collaboration](/collab/webrtc/) |
