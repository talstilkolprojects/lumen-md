---
title: Safe saves and the vault check
description: Every save lands whole, even if the app is killed half way; the vault check finds damaged files and repairs them with a backup first.
---

Your notes are real files. A save that stops half way — the battery dies,
the system kills the app, the computer crashes — must never leave a note
cut in two. Lumen makes sure it doesn't, and **Check vault integrity**
finds what other apps, sync clients or an older crash may have left.

## Every save lands whole

Lumen never writes over a note in place. The new text goes to a hidden
file next to the note first; only when all of it is on the disk does that
file take the note's name. If the app stops anywhere in between, the next
time it opens the folder it finishes the save or puts the previous version
back — so each note is always either the version before the save or the
version after it, complete.

| Where the vault is | How |
|---|---|
| **Desktop app** | Temporary file, `fsync`, rename over the note, then the folder is synced too. |
| **Chrome / Edge folder** | The browser writes a swap file and replaces the note when it is complete. |
| **Phone folder (iOS, Android)** | Temporary file `.lumen-tmp~…`, checked for its full size, then renamed; Android syncs the bytes to disk first. |
| **Browser storage on Safari** | The same temporary-file steps inside the write worker. |

A file name holds at most 255 bytes, and a Hebrew letter takes two. When
the temporary name of a long note name would not fit, the save uses short
names (`.lumen-tmp-<16 hex digits>`) and first writes a small journal
(`.lumen-jnl-…`) that records which note they belong to. The journal is
removed last, so a save stopped at any step can still be finished. If a
journal is lost, the old version is kept, never used to replace a note, and
the integrity check reports it.

This is tested by killing a process with `kill -9` in the middle of
saving, 1,000 times: `npm run test:crash`. After every kill each note is
whole and is its old or its new version.

## Check vault integrity

**Command palette → Check vault integrity** reads every file in the vault
(your own folders only — not `.git`, `.trash` or earlier backups) and opens
a report note. It looks for twelve kinds of damage:

| Problem | Repaired automatically |
|---|---|
| A file cut off in the middle of a character | Yes — the cut character is dropped |
| Text that is not UTF-8 (for example Hebrew saved as Windows-1255) | Yes — converted to UTF-8 |
| A file saved as UTF-16 | Yes — converted to UTF-8 |
| NUL bytes in a text file | Yes — removed |
| An empty file | No — bring a version back from the note's history |
| A JSON or YAML data file (`.canvas`, `.excalidraw`, `.base`, `.json`, `.yaml`) that does not parse | No |
| Front matter that never closes or is not valid YAML | No |
| Two names in one folder that differ only in upper/lower case | Yes — the second is renamed `name (2)` |
| Two names that differ only in Unicode form (é written two ways) | Yes — renamed the same way |
| A link to a note that is not there | No — use **Vault Doctor: Apply Suggested Link Fixes** |
| A temporary file of an interrupted save (Lumen's, the desktop app's, Chrome's `.crswap`) | Yes — removed |
| A save interrupted half way, with the note missing | Yes — the save is finished, or the old version comes back |

Names that differ only in case live side by side on Linux and in browser
storage, but on macOS, Windows and phones one of them hides the other —
which is how notes get lost when a vault moves or syncs.

When something can be repaired, Lumen asks once and then repairs it.
**Before any file is changed, renamed or removed, it is copied to
`.lumen-repair/<date and time>/`** in the vault, so every repair can be
undone by copying the file back. Notes that are open in a tab are left
alone, and a file that changed since the check is not touched.

The first check of a large vault takes a while: 10,000 notes took about
ten seconds in a browser (measured in Chromium) and two to three seconds
outside one. After that, a check reads again only the files whose size or
modification time changed, so the same 10,000 notes take under a second.
A file changed in the few seconds before a check is always read again.
