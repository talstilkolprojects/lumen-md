---
title: The desktop app
description: Windows, tabs you drag between them, the tray with quick capture, opening .md files from Finder or Explorer, and lumen:// links.
---

The desktop app (macOS, Windows, Linux) works like a native one.

## Windows and tabs

- **New window:** *File → New window* (⌘⇧N / Ctrl+Shift+N), or *New
  window* in the command palette. Every window shows the same vault and
  keeps its own tabs.
- **Move a tab:** drag it out of the tab strip and drop it on another
  window. Drop it outside every window to get a new window with that tab.
  The tab keeps its editing state: unsaved text, cursor and selection,
  scroll position and view mode. Undo history starts fresh in the new
  window.
- The move is safe: the first window keeps the tab until the second one
  has it open. If the second window closes first, nothing is lost.
- When you close an extra window, its tabs close with it. The main window
  remembers its tabs for the next launch.

## The tray

The Lumen icon in the menu bar (macOS) or the system tray (Windows, Linux)
has:

- **Quick capture…:** a small window. Type a thought and press Enter, and
  it is added to `inbox.md` with the date and time. Shift+Enter starts a
  new line, and Esc closes the window.
- **New note**, your **recent notes**, **Show Lumen** and **Quit Lumen**.

The menu follows the app's language.

## Opening files

Lumen registers itself for **`.md`** (and `.markdown`), **`.base`**
(database views) and **`.excalidraw`** (drawings). Double-click one in
Finder, Explorer or your file manager, or use *Open with → Lumen*, or run
`lumen note.md` in a terminal:

- **A file inside a vault** opens in that vault. If it belongs to a vault
  you used before, Lumen switches to it first. With vaults inside each
  other, the innermost one wins.
- **A file outside every vault** opens on its own. Saving writes it back
  to the same file, and nothing else on the disk becomes reachable.
- If Lumen is already running, the file opens in the running app. A second
  copy of Lumen is not started.

## Links: `lumen://`

| Link | What it does |
|---|---|
| `lumen://open?path=notes/idea.md` | opens a note of the current vault |
| `lumen://open?path=notes/idea.md&vault=Research` | opens it in the vault whose folder is named *Research* |
| `lumen://open?path=notes/idea.md&line=12` | opens it with the cursor on line 12 |
| `lumen://new` | opens a new note |
| `lumen://new?title=Idea&text=First%20line&folder=inbox` | opens a new note with that title and text; it isn't saved until you save it |
| `lumen://capture?text=Buy%20milk` | adds a line to `inbox.md` |

Encode values as you would in a URL. Hebrew works: `lumen://open?path=%D7%A8%D7%A2%D7%99%D7%95%D7%9F.md`.

Links are checked strictly, because a link can come from anywhere:

- `path` is inside the vault: no `..`, no absolute path, no drive letter;
- `vault` matches only a vault you opened before; a link can never point
  Lumen at a new folder;
- `new` opens an unsaved note, so nothing is written that you haven't seen.

To make a link from a page or a script, use the path relative to the vault
folder, with forward slashes.

## How it is tested

The shell's decisions are covered by tests in `src-tauri/desktop`
(`cargo test --offline --manifest-path src-tauri/desktop/Cargo.toml`). It
is plain Rust with no dependencies, and the tests cover:

- link parsing, including every way to escape the vault;
- which vault holds a file, with nested vaults, `..`, and case on macOS and
  Windows;
- launch arguments;
- where a dropped tab lands, and the two-phase move (never lost, never
  doubled);
- the tray menu and quick-capture entries.

The WebView side is covered by `src/__tests__/desktopShell.test.ts`.

What needs a person, on each of macOS, Windows and Linux:

1. Double-click a `.md` file in a vault you used before: Lumen opens in
   that vault, on that note.
2. Double-click a `.md` file outside every vault: it opens on its own, and
   saving changes the file.
3. Open `lumen://open?path=…` from a browser: the note opens. Then open
   `lumen://capture?text=test`: `inbox.md` gains a line.
4. Drag a tab with unsaved text to a second window: the text, cursor and
   scroll come along, and the first window no longer has the tab.
5. Tray → *Quick capture…* in Hebrew: the window is right to left, and
   Enter adds the line to the inbox.
