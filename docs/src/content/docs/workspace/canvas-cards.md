---
title: Note cards and image export
description: Put vault notes on the canvas as live cards, edit them in place, and export the canvas as PNG, SVG or PDF with Hebrew intact.
---

## Note cards

A note card is a note from your vault placed on the canvas. It shows the
note's title and first lines, and it moves, resizes, groups, sits in frames
and takes arrows like any other shape.

- **Add a card**: in the canvas bar, **+ Note card**, then type a note's
  name or `![[note]]`. You can also paste one or more `![[note]]` lines
  onto the canvas; each one becomes a card.
- **Edit in place**: click the card, click it again to work inside it, then
  double-click its text. `⌘Enter` (or clicking outside) saves into the
  note, and `Esc` cancels. The frontmatter is kept as it was.
- **Open**: the card's **Open** button closes the canvas and opens the note
  in a tab.

Names resolve the way Obsidian resolves them. A full path wins; otherwise
the note with that file name and the shortest path is used. A card whose
note was moved or deleted says so.

In the `.excalidraw` file a card is an embed whose link is
`lumen-note:<path>`. In [JSON Canvas](/workspace/json-canvas/) it's a
`file` node, as in Obsidian Canvas. Importing a `.canvas` turns its
Markdown file nodes into cards; images and other files stay as shapes.

Only the cards in view are drawn, and each note is read once, so a canvas
with 50 cards opens in under 1.5 seconds.

## Export: PNG, SVG, PDF

Use **PNG**, **SVG** and **PDF** in the canvas bar.

- Note cards are drawn as their title and first lines. Hebrew cards are
  aligned right.
- **SVG** fixes how Excalidraw writes right-to-left text. Each line gets
  its own direction and is placed on the side where the canvas draws it.
  Without this, right-aligned Hebrew would fall outside the image.
- SVG also embeds the Hebrew font (Assistant, limited to the Hebrew range),
  so the file looks the same on a computer without Hebrew fonts.
- **PNG** is drawn at twice the size, after the Hebrew font has loaded.
- **PDF** prints the SVG on a page of its own size. Choose "Save as PDF",
  and the Hebrew stays text you can select.

Everything is exported on this device. The fonts come from the app itself.
