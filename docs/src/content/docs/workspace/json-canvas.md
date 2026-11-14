---
title: JSON Canvas (Obsidian .canvas)
description: Open Obsidian canvases in Lumen's Excalidraw canvas and write them back as .canvas files. JSON Canvas is an open, MIT-licensed format.
---

[JSON Canvas](https://jsoncanvas.org) is the open format Obsidian uses for its
canvases (`.canvas` files, spec 1.0, MIT licensed). Lumen's
[canvas](/workspace/canvas/) reads and writes it. Everything runs on your device.

## Import

- **Import .canvas** in the canvas bar: pick a `.canvas` file. It becomes a new
  canvas, `canvases/<name>.excalidraw`, and opens. If that name is taken, you
  get `<name>-2`, `<name>-3` and so on, and nothing is overwritten.
- A `.canvas` file already in the vault's `canvases/` folder (for example from
  a synced Obsidian vault) is listed in the picker with a **Convert** button,
  like old tldraw canvases. The `.canvas` file stays as it was.

## Export

**Export .canvas** writes the open canvas to `canvases/<name>.canvas`, next to
its `.excalidraw` file, as tab-indented JSON like Obsidian writes it.
Exporting again replaces that `.canvas` file. The `.excalidraw` file is not
touched.

## How it maps

| JSON Canvas | Excalidraw |
|---|---|
| Text node (Markdown) | Rectangle with the text inside (shown as written, not rendered) |
| File node (`file`, `subpath`) | Rectangle showing the path, with the path as the element's link |
| Link node (`url`) | Rectangle showing the URL, with the URL as the element's link |
| Group (`label`) | Frame with the label as its name. Nodes inside it belong to the frame (to the smallest one, since Excalidraw frames don't nest) |
| Edge (`fromSide`/`toSide`, `fromEnd`/`toEnd`, `label`) | Arrow bound to both nodes at those sides, with arrowheads per end and the label on the arrow |
| Colour: preset `1`–`6` or hex | Stroke colour (the presets as Obsidian draws them: red, orange, yellow, green, cyan, purple) |

**Round trip.** Each element keeps the node or edge it came from, so a canvas
that is imported and exported without edits comes back the same, including
what Excalidraw has no place for: a file's subpath, a group's background, and
fields added by other apps. Edits are written back. Moved or resized nodes,
changed text, a changed link (`Notes/Plan.md#Goals` → `file` + `subpath`),
recoloured elements and arrows that now connect different nodes are all
exported.

**Drawn in Excalidraw.** Rectangles, ellipses and diamonds become text nodes
(with the text inside them), a shape with a link becomes a link or file node,
free text becomes a text node, frames become groups, and arrows bound to two
of those become edges. Images, free-hand strokes, lines and arrows not
connected at both ends have no JSON Canvas form. They are left out of the
`.canvas` file, the export says how many, and they stay in the
`.excalidraw` canvas.
