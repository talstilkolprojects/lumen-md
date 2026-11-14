---
title: Hebrew keyboard layout
description: Shortcuts that work with the Hebrew layout on, and search that understands text typed with the wrong layout.
---

## Shortcuts work in any layout

Lumen reads a shortcut by the **key you press**, not by the letter it types.
With the Hebrew layout on, **Ctrl+K** (⌘K) still opens the palette, even
though that key types ל. The same holds for every shortcut: save, open, new,
the editor modes (⌘1–⌘4), find and replace, the shortcuts list (⌘/), undo,
redo and the rest.

With the Hebrew layout active, the shortcuts list (⌘/ / Ctrl+/) shows the
Hebrew letter on each key too: **Ctrl+K (ל)**. Lumen knows the layout from
what you last typed, or from the interface language if you haven't typed yet.

**AltGr** (Ctrl+Alt on Windows) never triggers a shortcut. Characters typed
with AltGr stay characters.

## Typed with the wrong layout

`akuo` is `שלום` typed with the English layout on, and `יקךךם` is `hello`
typed with the Hebrew one. The **command palette** and **workspace search**
read your text both ways:

- The palette shows matches for what you typed first, then matches for the
  other-layout reading, with a note: *Also showing results for “חיפוש”*.
- Search tries the other reading when what you typed finds fewer than three
  notes.

Only text in a single script is converted. Mixed Hebrew and English is taken
as you typed it.

## How it is checked

`src/__tests__/keyboardLayout.test.ts`:

- 50 golden wrong-layout queries (25 each way) must find the right command in
  the top 3, in at least 95% of cases.
- Every shortcut is checked with the English layout, the Hebrew layout and
  macOS ⌘.
- No two shortcuts may share a key, and every shortcut the palette shows must
  be the one the app binds.

`e2e/hebrew-layout.spec.ts` presses the shortcuts as the Hebrew layout sends
them.
