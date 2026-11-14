---
title: Your vault in a folder
description: Keep your notes in a real folder on your computer, in the browser or the desktop app, move them there and back without losing a byte, and see changes other programs make.
---

By default the web app keeps your notes in the browser's private storage
(OPFS). You can keep them in an ordinary folder on your computer instead,
where Obsidian, a backup tool or a file manager sees the same files. For a
folder on the phone, see [Vault in a folder on the phone](/workspace/mobile-vault-folder/).

## In the browser

In Chrome and Edge, three commands in the palette (**⌘K**) choose where the
vault lives:

| Command | What it does |
|---|---|
| **Move the vault to a folder…** | Copies every note, attachment and the trash to a folder you pick, reads each copy back and compares it byte for byte, then works there. Browser storage is not deleted. |
| **Open a folder as the vault…** | Works in an existing folder, for example an Obsidian vault, without copying. |
| **Move the vault back to browser storage** | The same careful copy in the other direction. The folder is not changed. |

If the folder already holds different files at the same paths, the move
stops before writing anything and names them. Identical files are merged.
Firefox and Safari can't open a folder from a web page, so there the
commands say that the vault stays in browser storage and suggest Chrome,
Edge or the desktop app.

After a restart, Lumen reopens the same folder. When the browser wants a
click before it allows that, nothing is read or written until you answer
the banner: **Reconnect folder** or **Use browser storage**. A move that
was cut off (a closed tab, a full disk) changes nothing; the banner offers
**Resume move**, which skips files already copied, or **Cancel move**.

## In the desktop app

The first time the desktop app starts, it asks for a vault folder
(**Choose folder…**, or **Not now**). Notes that were already in the
app's storage are first saved as a zip backup in the app's data folder,
then moved with the same byte-for-byte check, and the app's storage is
never deleted. On later starts the app reopens that folder. If the folder
is gone, nothing is read or written anywhere until you pick it again.

The app can reach only the folder you picked: paths that leave it,
including through a symbolic link, are refused. Every save writes a
temporary file and renames it, so other programs never see a half-written
note.

## Changes made outside Lumen

When another program edits, adds, renames or deletes a file in the vault
folder, Lumen notices within about two seconds and updates the file tree,
search, tags and backlinks. For the notes you have open:

| On disk | In the open tab |
|---|---|
| Changed, and you have no unsaved edits | The new text, with a message |
| Changed while you have unsaved edits | A conflict, and nothing is lost (below) |
| Renamed or moved | The tab follows the new path |
| Deleted | The text stays open, marked unsaved, and is not written back by itself |

On a conflict, the version on disk is first kept as
`Name (changed outside Lumen <time>).md`, saving that note pauses, and a
dialog shows both versions: **Keep mine**, **Take theirs** or
**Apply merge**. Taking theirs removes the copy, since the note holds that
text again. Every save also checks first that the file still holds what
Lumen last saw there, so a change made a moment before the save is never
overwritten.

Browser storage is not watched: it belongs to Lumen alone, so no other
program writes to it.
