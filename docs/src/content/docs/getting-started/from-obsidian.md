---
title: Moving from Obsidian
description: Bring an Obsidian vault into Lumen — notes, attachments, links and Bases — and what changes on the way.
---

An Obsidian vault is a folder of Markdown files, and so is a Lumen vault:
nothing has to be converted.

## Bring the vault in

1. In Obsidian nothing needs exporting. Zip the vault folder, or keep it as
   a folder.
2. In Lumen: `⌘K → Import notes from another app (Obsidian, Notion, Evernote, Bear, Keep, Logseq, OneNote…)…`
   and pick the .zip or the folder.
3. Lumen recognises the vault by its `.obsidian/` folder and imports every
   note and attachment into a new folder, `Imported/<vault name>`. Nothing
   that is already in Lumen is overwritten. Obsidian's own settings
   (`.obsidian/`, `.trash/`) stay behind.

Details and the full list of what is skipped: [Export and
import](/workspace/export-import/).

## What carries over

| In Obsidian | In Lumen |
|---|---|
| `[[wikilinks]]`, `[[note#heading]]`, `![[embeds]]` | the same syntax |
| Frontmatter properties, `tags:` | the same YAML; the tags panel and database views read it |
| Attachments (images, PDFs) | the same files, the same relative links |
| Callouts `> [!note]` | shown as a quote; Lumen's callouts are `:::note` blocks |
| Canvas (`.canvas`) | kept as files |
| Plugins and themes | not carried over: Lumen has its own [plugins](/plugins/sdk/) |

## Daily habits

- **Command palette**: `⌘K`, as `⌘P` in Obsidian. [Keyboard
  shortcuts](/getting-started/shortcuts/) lists the rest.
- **Hebrew**: the editor and preview are right-to-left aware per paragraph;
  see [Hebrew and right-to-left](/editor/hebrew/).
- **Sync**: Obsidian Sync does not reach Lumen. Use Git, or keep the vault
  in a folder both apps open on the desktop.

## Going back

Your notes stay plain Markdown. `⌘K → Export the whole vault…` gives you a
.zip or a folder that Obsidian opens as a vault.
