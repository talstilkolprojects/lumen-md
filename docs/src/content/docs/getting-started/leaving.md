---
title: Leaving Evernote or Notion?
description: How to take your notes out of Evernote, Notion, Apple Notes, Google Keep, OneNote or Obsidian, and bring them into Lumen in one step, with one click to take it back.
---

Lumen keeps your notes as plain Markdown files on your device. Bringing them
in from another app takes two steps: export from that app, then pick the
export in Lumen. The import goes into a new folder, `Imported/<name>`.
Nothing you already have is changed, and **Undo** takes the whole import
back.

**[Open the import wizard in Lumen](https://lumen-md.vercel.app/?import=evernote)**.
On a first visit, setup's last step offers **Bring your notes** instead.

Each section below describes the other app's export as that app's own help
page does, and links to it. If the steps there have changed, follow them.

## Evernote

1. Open the Evernote **desktop app** for Mac or Windows. Evernote Web can't export.
2. Select a notebook, or up to 100 notes, then right-click → **Export…** → **ENEX**.
3. In Lumen, choose **Evernote** and pick the `.enex` files. Each notebook becomes a folder.

Source: [Evernote help, "Export notes and notebooks as ENEX or HTML"](https://help.evernote.com/hc/articles/209005557).

<!-- screenshot: leaving/evernote-export.png (W10.M9) -->

More detail: [Moving from Evernote](/getting-started/from-evernote/).

## Notion

1. In Notion, export the workspace or a page as **Markdown & CSV**, with subpages included.
2. In Lumen, choose **Notion** and pick the `.zip` as it came. Every database becomes a `.base` file with the same columns.

Source: [Notion help, "Export your content"](https://www.notion.com/help/export-your-content).

<!-- screenshot: leaving/notion-export.png (W10.M9) -->

More detail: [Moving from Notion](/getting-started/from-notion/).

## Apple Notes

1. In Notes on a Mac, select a note, then **File → Export To** → **Markdown** (or PDF). The Apple guide describes one note at a time.
2. Put the exported files in one folder. In Lumen, choose **Apple Notes** and pick the folder, or a `.zip` of it.

Source: [Apple, "Import, export and print notes on Mac"](https://support.apple.com/guide/notes/not201900c07/mac).

<!-- screenshot: leaving/apple-notes-export.png (W10.M9) -->

## Google Keep

1. At Google Takeout, select only **Keep** and download the `.zip`.
2. In Lumen, choose **Google Keep** and pick the `.zip` as it came. Labels become tags, and archived notes go to `Archive/`.

Source: [Google Account help, "How to download your Google data"](https://support.google.com/accounts/answer/3024190).

<!-- screenshot: leaving/keep-takeout.png (W10.M9) -->

## OneNote

1. In OneNote, **File → Export** → *Export current:* **Page** or **Section**, then pick the format.
2. Lumen reads pages saved as **Single File Web Page (`.mht`)**. In Lumen, choose **OneNote** and pick the `.mht` files.

Source: [Microsoft support, "Export a copy of a page, section or notebook"](https://support.microsoft.com/en-au/office/export-a-copy-of-a-page-section-or-notebook-0958461c-fc32-4659-9341-707d5a457e09). Which formats you are offered depends on your OneNote version. The page doesn't list `.mht`, so check the format list in your copy.

<!-- screenshot: leaving/onenote-export.png (W10.M9) -->

## Obsidian

An Obsidian vault is already a folder of Markdown files, so there's nothing to export:

- **Open an Obsidian folder** in setup uses the vault where it is, with nothing copied.
- Or import a copy: choose **Obsidian** and pick the folder or a `.zip` of it.

More detail: [Moving from Obsidian](/getting-started/from-obsidian/).

## After the import

The wizard shows what came in and what didn't, and why. It also offers a
search over the notes you just imported, and **Undo**. The full list of what
each importer keeps and skips is in [Export and import](/workspace/export-import/).
