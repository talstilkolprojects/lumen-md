---
title: Graph and local graph
description: The knowledge graph of the whole vault — 10,000 notes and 50,000 links — and the local graph of the open note, with filters, colour groups and full keyboard use.
---

## The graph

**Knowledge Graph** (command palette) shows every note of the vault, and a line
for every `[[link]]` between two notes.

- **Big vaults.** The graph is built from the vault index, so the notes
  are not read again. The layout is computed in a background worker; the
  picture appears at once and settles over a second or two. Nodes and
  links are drawn with WebGL, so 10,000 notes and 50,000 links pan and
  zoom smoothly. While you move the view, a sample of the links is drawn;
  all of them come back as soon as you stop.
- **Filters.** Narrow the graph by **tag** (nested tags included:
  `project` keeps `project/active`), by **folder** (and its subfolders),
  or by a frontmatter **property**: `status=open`, or just `status` for any
  note that has one.
- **Colour groups.** Colour the notes by their top folder or their first
  tag. The legend shows the twelve biggest groups.
- **Labels** show for the bigger notes, and for more of them as you zoom
  in. Hebrew names are shaped and written right to left.

## The local graph

**Show / hide the local graph** opens a panel beside the note: the open
note in the middle, and the notes within **1, 2 or 3** links of it. It has
the same tag and folder filters, and is coloured by folder. It follows you
as you open other notes, and opens in well under a fifth of a second.

## With the keyboard

The graph is one focusable area. Tab to it, and:

| Key | Does |
|---|---|
| ← ↑ → ↓ | go to the linked note in that direction (or, if there is none, the nearest note that way) |
| Enter | open the focused note |
| + / − | zoom in / out |
| 0 | fit the whole graph |
| Shift + arrows | pan |
| Home | back to the biggest note (in the local graph: the open note) |

The focused note's name and number of links are announced to screen
readers. In the full graph, the **Find a note** box jumps to any note by
name, so every note can be reached without a mouse.
