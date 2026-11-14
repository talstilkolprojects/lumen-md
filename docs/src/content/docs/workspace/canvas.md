---
title: Canvas (Excalidraw)
description: The whiteboard — on Excalidraw, saved as open .excalidraw files in your vault, fully on your device — and what happens to your old tldraw canvases.
---

The canvas (`🎨 Canvas / Whiteboard`, `⌘K`) is
[Excalidraw](https://github.com/excalidraw/excalidraw): shapes, arrows,
free-hand drawing, text, images and frames, with Excalidraw's own tools,
menus and keyboard shortcuts, in the language of the interface. Excalidraw is
MIT licensed and runs fully on your device. (Until October 2026 the canvas was
tldraw, which needs a licence key in production and contacts its CDN.)

## Nothing leaves the device

Under the **local-only** policy the canvas makes zero network requests, and
under every policy it makes none that carry your drawing:

- Excalidraw's fonts are served by Lumen itself, from `/excalidraw/fonts/`,
  not from a CDN, and are cached for offline use the first time they load.
- Its interface translations are part of the app.
- Excalidraw's AI, collaboration, "shareable link" and library-browser
  features are switched off.

Every canvas is saved automatically, half a second after a change, to
`canvases/<name>.excalidraw` in your vault. The last change is written when
you close the canvas or switch to another one.

## Hebrew and right-to-left text

Type Hebrew into a text element and it is laid out right-to-left while you
edit it. Excalidraw's hand-drawn fonts have no Hebrew glyphs, so Lumen draws
Hebrew letters with **Assistant** (the Hebrew font Excalidraw ships) inside
every canvas font — mixed Hebrew/English text keeps both. With the interface
in Hebrew or Arabic, Excalidraw's menus and panels are right-to-left too.

## Your old tldraw canvases

## Where canvases live

| Before | After |
|---|---|
| `canvases/<name>.tldr` (tldraw snapshot) | `canvases/<name>.excalidraw` (Excalidraw scene, open JSON) |

An `.excalidraw` file is the standard Excalidraw format. It opens in any
Excalidraw app, and it is pretty-printed, so diffs stay readable in a
git-synced vault.

## Converting

Command: `🎨 Canvas: convert tldraw canvases to Excalidraw`. The canvas
picker also lists each `.tldr` (and each `.canvas.json` from the first Lumen
whiteboard) that has no `.excalidraw` yet, with a **Convert** button.

It converts every `.tldr` canvas in the vault in one go and reports how many
were converted, skipped or failed, plus a warning list per canvas. It runs
on your device and makes no network requests.

**The backup.** Your `.tldr` files are never changed, renamed or deleted.
Each one stays next to its new `.excalidraw` file. If a canvas already has an
`.excalidraw` file, it is skipped, so your Excalidraw work is never
overwritten. Running the command twice does nothing the second time.

## What converts

| tldraw | Excalidraw |
|---|---|
| Rectangle, ellipse, diamond (with label) | Rectangle, ellipse, diamond, with the label bound inside |
| Triangle, trapezoid, rhombus, pentagon, hexagon, octagon, star, block arrows | A closed polygon, with the label grouped with it |
| Cloud, heart, oval | Ellipse |
| Check box, x box | Rectangle (the inner mark is dropped) |
| Text | Text: same characters, size and colour |
| Sticky note | Filled rectangle with the text inside |
| Arrow, including its label and bend | Arrow, curved through the same midpoint, label bound to it |
| Arrow connected to a shape | Arrow bound to the same shape, at both ends |
| Frame and the shapes in it | Frame, with its shapes inside |
| Group | Excalidraw group (nested groups too) |
| Image embedded in the canvas | Image, with crop and flip |
| Freehand drawing, highlighter | Freehand stroke (pen pressure kept) |
| Line | Line (smooth if it was a spline) |

Ids, positions, sizes, rotation, opacity, locks, links and colours carry
over. Colours map to the closest Excalidraw colour, and sizes to stroke widths
and font sizes.

## What doesn't convert exactly

Every one of these is kept as something you can see and is listed in the
warning report. Nothing is dropped silently.

- **A frame inside a frame.** Excalidraw frames don't nest. The inner frame
  becomes a top-level frame, and its shapes stay in it.
- **Elbow arrows** become straight arrows.
- **Video, embeds, bookmarks and unknown shapes** become a dashed rectangle
  labelled with the shape type, and the link is kept on it.
- **Images that weren't embedded** (a web address or a missing file) become
  a placeholder with the link. Nothing is downloaded during the conversion.
- **More than one page.** Excalidraw has a single scene, so later pages are
  placed to the right of the previous one.
- **Text formatting** (bold, italic, links inside text) becomes plain text.
  List bullets and numbers are kept as characters.

## Hebrew and right-to-left text

Text is copied exactly, character for character. Excalidraw text has no
direction setting, so the conversion sets the alignment: text that tldraw
aligned to the *start* is aligned right when it begins with Hebrew or Arabic,
and left otherwise.

Converted Hebrew text is drawn with Assistant, like text typed in the canvas.

## Older canvases

The converter reads every format a canvas may have been saved in: what the
current tldraw canvas saves, older tldraw snapshots (plain text instead of
rich text, arrows connected the old way), and `.tldr` files exported from
tldraw itself. Canvases from the first Lumen whiteboard (`.canvas.json`) convert
straight to Excalidraw from the canvas picker: each card becomes a note at
its position (its connections never had an equivalent).
