---
title: Moving from Bear
description: Export Bear notes as Markdown and bring them, with their images, into Lumen.
---

## Export from Bear

1. Select the notes (or **⌘A** in a tag).
2. **File → Export Notes…**, format **Markdown**, with **Export attachments**
   on. Bear writes one `.md` file per note and a folder of images next to
   each.

## Bring it in

Zip the export folder, or keep it as a folder, then
`⌘K → Import notes from another app (Obsidian, Notion, Evernote, Bear, Keep, Logseq, OneNote…)…`. The notes and
their images go into a new folder, `Imported/<name>`, with the image links
intact.

## What changes

| In Bear | In Lumen |
|---|---|
| `#tags` and `#nested/tags` | the same inline tags; the tags panel lists them |
| `#multi word tags#` | write them as `#multi-word-tags` (Lumen tags have no spaces) |
| `::highlight::` | kept as text; Markdown has no highlight (use **bold**, or `{==highlight==}` in suggesting mode) |
| `[[note links]]` | the same syntax |
| Sync between devices | Bear's iCloud sync does not reach Lumen; use Git or a shared folder |
