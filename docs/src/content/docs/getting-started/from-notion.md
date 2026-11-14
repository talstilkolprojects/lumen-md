---
title: Moving from Notion
description: Export a Notion workspace and bring its pages, links and attachments into Lumen.
---

## Export from Notion

1. In Notion: **Settings → Export** (a single page: **⋯ → Export**).
2. Choose **Markdown & CSV**, include subpages, and download the .zip.

## Bring it in

`⌘K → Import notes from another app (Obsidian, Notion, Evernote, Bear, Keep, Logseq, OneNote…)…`, then pick the
.zip as it came. Lumen recognises a Notion export by the 32-character IDs
Notion adds to every file name, and:

- removes the IDs from file and folder names (`Plans 1a2b….md` → `Plans.md`);
- rewrites the links between pages to the new names, keeping `#headings`;
- numbers two pages that end up with the same name (`Page 2.md`) and keeps
  the links pointing at the right one;
- imports everything into a new folder, `Imported/<name>`, never over an
  existing note.

## What changes

| In Notion | In Lumen |
|---|---|
| Pages and subpages | Markdown files and folders |
| Databases | a `.csv` per database, next to a folder of its rows; open the CSV as a table, or build a [database view](/workspace/database-views/) over the rows |
| Toggles, callouts | Markdown lists and blockquotes |
| Comments, page history, permissions | not in the export |

## Hebrew

Notion keeps Hebrew page titles in file names; Lumen keeps them as they
are. Right-to-left paragraphs are detected per paragraph — see [Hebrew and
right-to-left](/editor/hebrew/).
