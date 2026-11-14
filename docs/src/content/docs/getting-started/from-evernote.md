---
title: Moving from Evernote
description: Get your notebooks out of Evernote and into Lumen as Markdown, with their images and attachments.
---

Evernote keeps notes in its own format (ENML), so they are converted on the
way in.

## Export from Evernote

1. Select a notebook (or the notes you want).
2. **File → Export notes…** (or **⋯ → Export**).

## Bring it in

:::note[Coming with the import wizard]
The import wizard (plan W1.26) reads `.enex` exports directly: one folder
per notebook, images and files in place, to-dos as tasks, tags and the
creation and edit dates as properties. Until it ships in your version, use
the HTML route below.
:::

**HTML route**: export the notes as **HTML** (one file per note). In Lumen,
open each file (`⌘O`) or drop it on the window — the HTML is converted to
Markdown, images included — and save it to your vault.

## What changes

| In Evernote | In Lumen |
|---|---|
| Notebooks and stacks | folders |
| Tags | `tags:` in each note's frontmatter |
| Checklists | Markdown tasks `- [ ]` |
| Encrypted text | stays out (Evernote does not export it in the clear) |
| Reminders, sharing | not in the export |
