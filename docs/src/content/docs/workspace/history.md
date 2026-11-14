---
title: Version history and undoing a delete
description: Every note keeps its earlier versions, shared sessions included, in little space; a delete is undone with Ctrl+Z or from the trash; and the history panel shows whether the browser may clear your storage.
---

Lumen keeps what you wrote. Each note has a history of versions you can
read and restore, and a deleted note or folder goes to the trash, from
where one key brings it back.

## Version history

**⌘K → Version History** opens the open note's versions, newest first.
Pick one to preview it, with how many characters it differs by, then
**Restore this version**. Restoring keeps the current text as a version first, so a
restore can be undone too. **Keep a version now** saves one on demand.

A version is kept every couple of minutes while you type, on every save,
when you close the tab, before a git pull, before a restore, and every
ten minutes for the whole vault (also when the tab goes to the
background). Each version says why it was kept. Versions from a shared
editing session are kept in the same history, with who wrote them
("collab session · by …"), every five minutes and once more when the
session ends.

## How it stays small

Most versions are stored as the lines that changed from the version
before, compressed, with the full text every 20 versions. When the oldest
versions are removed, the oldest one left becomes a full text again, so
every remaining version still reads back exactly. A thousand versions of
a 6 KB note take about 6% of the space their full texts would.

Older copies that earlier versions of Lumen kept in a `backups/` folder
are moved into the history once, with their original times ("from old
backups"). The emptied folder goes to the trash. A `backups/` folder that
also holds your own notes is left where it is.

## Storage the browser may not clear

Browsers can clear a site's storage when the disk runs low, unless the
site's storage is persistent. The Version History panel shows which one
you have, how much is used (`X of Y`), and a **Keep my storage** button
that asks the browser to make it persistent. When storage passes 80%
full, Lumen tells you, and the oldest versions are removed first if it
runs out.

## Undoing a delete

A deleted note or folder goes to the trash for 30 days
(**⌘K → Trash…** restores it). Right after a delete, the message offers
**Undo**.

**⌘Z** / **Ctrl+Z** with the focus outside an editor (in the file tree, a
panel or the page) restores the last delete. Each press restores the one
before it, up to the last 20 deletes, and a delete of many files at once
counts as one. Inside the editor, a text field or the canvas, the same
key is their own undo. It also works on a Hebrew keyboard layout.

Before a note or folder is deleted, the unsaved edits of every open tab
inside it are saved, so restoring it brings back what you last typed.
