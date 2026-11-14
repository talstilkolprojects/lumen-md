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

## Databases: what comes across

Twenty kinds of Notion database content, each checked after import (`src/__tests__/notionScenarios.test.ts`, 20 of 20 pass). What Notion keeps only inside Notion, the formula and rollup *definitions*, comes across as its values, and the import report says so for each such column. Add the formula again as a formula column in the base if you need it live.

| | In the export | After import |
| --- | --- | --- |
| 1 | Plain database: text, select, number | the same columns, in order, in a `.base`; each row a note with typed values |
| 2 | Hebrew database and column names | Hebrew titles, folders and property names as they are |
| 3 | Checkbox | `Yes` / `No` → `true` / `false` |
| 4 | Numbers with thousands or currency | `$1,200.00`, `₪45` → numbers |
| 5 | Percent | `45%` → `0.45`, the number Notion stores |
| 6 | Dates and date-times | ISO dates the base sorts and filters |
| 7 | Date range | start in the column, end in `<column> end` |
| 8 | Multi-select | kept as Notion writes it (`a, b`); `contains` finds each value |
| 9 | Relation to another database | a list of `[[links]]` to the imported notes |
| 10 | Relation as notion.so links | `[[links]]` too |
| 11 | Rollup (Markdown & CSV) | its values, as numbers |
| 12 | Formula (HTML export) | its values; the report says the formula itself did not come across |
| 13 | Rollup (HTML export) | its values; the report names the rollup |
| 14 | Formula with text values | the text as it was shown |
| 15 | URL, email, phone | text, unchanged |
| 16 | Person, Created by | the names as text |
| 17 | Created / Last edited time | date-times |
| 18 | Row pages with content | the page body kept; the cells Notion repeats under the title move into the frontmatter |
| 19 | A view's CSV next to `_all.csv` | every row from `_all.csv`; the view's copy listed as a duplicate |
| 20 | A number column with an odd cell (`N/A`) | kept as text, and the report names the column and the cell |

## Hebrew

Notion keeps Hebrew page titles in file names; Lumen keeps them as they
are. Right-to-left paragraphs are detected per paragraph — see [Hebrew and
right-to-left](/editor/hebrew/).
