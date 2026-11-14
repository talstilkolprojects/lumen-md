---
title: Import from other apps
description: Bring notes from Obsidian, Notion, Evernote, Bear, Apple Notes, Google Keep, Logseq or OneNote — into a new folder, with a report, undone in one click.
---

**File → Import notes from another app…** (or the command palette) opens
the import wizard. It never touches what you already have: everything goes
into a new folder, `Imported/<name of the export>`, numbered when the name
is taken. One click — **Undo the import** in the wizard, or the command
**Undo the last import** later — takes it back.

## Three steps

1. **Pick the app** the notes come from. The wizard tells you how to export
   from it.
2. **Pick the export** — a file, several files, or a folder (or drop them on
   the wizard). Archives are opened, also archives inside archives (Notion
   zips its parts). If the files look like another app's export, the wizard
   says so and switches in one click.
3. **Check, then import.** Before anything is written you see how many
   notes, attachments and databases will come in, what will not and why,
   and how many internal links reach their note.

## What each app becomes

| App | Export to pick | What it becomes |
|---|---|---|
| Obsidian | the vault folder, or a .zip of it | the vault as it is; `.obsidian/` and `.trash/` are left out |
| Notion | Settings → Export → *Markdown & CSV* or *HTML*, the .zip as it came | names without Notion's ids; links follow the pages; **each database becomes a `.base` file** with the same columns, and each row a note whose properties are the row's cells (Yes/No, numbers and dates typed) |
| Evernote | `.enex` files (one per notebook) | a folder per notebook; tasks, images and files in place (`_resources/<note>/`); tags, author, source URL, created and updated as properties; links between notes as `[[wikilinks]]`; encrypted parts are left out and reported |
| Bear | a backup (`.bearbk`) or TextBundles | a note per bundle with its `assets/`; `::highlight::` → `==highlight==`, `#multi word tag#` → `#multi-word-tag`; trashed notes left out |
| Apple Notes | HTML or Markdown from an exporter app | a note per page; images inside the HTML (`data:` URIs) become files; links between pages follow |
| Google Keep | Google Takeout (Keep only), the .zip | checklists as tasks; labels as tags; colour and pin as properties; archived notes in `Archive/`; trashed notes left out |
| Logseq | the graph folder, or a .zip | page properties as frontmatter; `TODO`/`DONE` as tasks; block references `((id))` and `{{embed}}` as `[[Page#^id]]` / `![[…]]`; journals named by date (`2024-01-31`); `a___b` pages as folders |
| OneNote | pages or sections saved as *Single File Web Page* (`.mht`) | a note per page, its images and attached files next to it |

Dates are kept as the properties `created` and `updated` (a browser cannot
set a file's own dates). Hebrew names — files, folders, tags, properties —
stay as they are; only characters a file system refuses are replaced.

## The report

The last step shows what came in, what did not and why (the app's own
settings, its trash, a second copy of a file, a format the app cannot
convert, a damaged file), notes that came with something missing (an
attachment the export does not have, an encrypted part, no dates), and links
that point at nothing. **Save the report as a note** puts it in the import's
folder (undo takes it back too).

## Undo

Undo deletes exactly what the import wrote: its folder, and `Imported/` when
the import made it. The vault is then the same, byte for byte, as before the
import. If you changed something in the folder after the import, undo moves
the folder to the trash instead, so nothing of yours is lost.

## Limits

- Apple Notes has no export of its own, and reading its database needs the
  Mac app; the wizard imports what an exporter app saved.
- OneNote's own `.one` files cannot be read; export pages or sections as
  `.mht`.
- Notion's links to a block (`#…` after a page) go to the page: the block
  ids do not survive the export.

## How it is checked

`src/__tests__/importWizard.test.ts` imports one golden export per app
(`src/__tests__/fixtures/import/exports.ts`): 0 attachments lost, at least
98 % of internal links resolved, the Notion database as a `.base` with the
same columns and rows, and an undo that gives back the same vault hash.
`e2e/import-wizard.spec.ts` runs the wizard in the browser. The golden
exports are written from each app's documented format; real exports from
the apps are the owner's check.
