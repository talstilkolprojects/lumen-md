---
title: Outline mode and block operations
description: Fold headings and lists, zoom into one block, and move, indent, duplicate or delete whole blocks — on a plain Markdown file, in both editors.
---

Logseq, Tana and Workflowy made writing in an outline its own way of
working. Lumen gives you the same moves on an ordinary Markdown note: the
file stays plain Markdown, with nothing added to it.

## What a block is

- A **heading** together with its section: everything up to the next heading
  of the same or a higher level.
- A **list item** together with its children: the lines indented under it.
- Any other top-level block: a paragraph, a code block, a table, a quote.

Code is never structure: a `# line` or a `- line` inside a fenced code block
is left alone.

## The operations

They work the same in the source editor and in WYSIWYG, and in Hebrew
(right to left) as in English. Each is also in the command palette, under
**Outline: …**.

| Operation | Keys (Windows / Linux) | macOS |
|---|---|---|
| Move block up / down | Alt+Shift+↑ / ↓ | ⌥⇧↑ / ↓ |
| Indent / outdent | Ctrl+Alt+→ / ← | ⌘⌥→ / ← |
| Duplicate block | Alt+Shift+D | ⌥⇧D |
| Delete block | Alt+Shift+Backspace | ⌥⇧⌫ |
| Fold / unfold | Ctrl+Alt+↑ / ↓ | ⌘⌥↑ / ↓ |
| Zoom into the block / zoom out | Ctrl+Alt+Enter (Escape zooms out) | ⌘⌥↵ |
| Fold all / unfold all | palette | palette |

- **Moving** swaps the block with its neighbour at the same level, and the
  blank lines stay where they were. A heading moves with its whole section;
  a list item moves with its children. The first child of a section or a list
  doesn't leave its parent.
- **Indenting** a list item makes it the last child of the item before it;
  outdenting lifts it one level. Indenting a heading demotes its whole
  section (`#` → `##`, and every sub-heading with it).
- **In a right-to-left line the arrows follow the text**: the arrow that
  points to the line's end indents. In Hebrew that is Ctrl+Alt+←.
- **Zoom** shows only the block and its children, with a bar that takes you
  back to the whole note.

Drag and drop of blocks is in the WYSIWYG editor (the ⠿ handle beside a
block).

## Open a note as an outline

**Open note as outline** in the palette turns on fold toggles beside
headings and list items and folds everything to the top level — a note from
Logseq, made of nested `- ` items, opens as an outline you can expand step
by step. Run it again to turn it off. It is remembered for each note.

## Nothing goes into the file

Folding and zoom only change what you see. The note is byte-for-byte the
same after folding, zooming and unfolding. Which blocks are folded is kept
for each note in the browser (localStorage), not in the file, so the file
reads the same in every other editor and in Git. A section folded in one
editor is folded in the other.
