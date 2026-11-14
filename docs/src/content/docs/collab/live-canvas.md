---
title: Live canvas
description: Draw on one canvas together during a collab session — edits and pointers appear as they happen, over the same encrypted room as the note.
---

When you share a note in a live session, the canvas you open is shared too.
Everyone in the room who opens the same canvas (same name) sees the others'
shapes, text and arrows change as they draw, and their pointers with their
names.

## How it works

- The canvas travels in the session's document, next to the note. In a room
  with a password it is end-to-end encrypted like the note. On the public
  server, the room only lets in people who hold the share link's password
  ([persistent rooms](/collab/persistent/)). Nothing about the drawing
  reaches a server in the clear.
- Two people can change the same shape at the same moment. Lumen uses
  Excalidraw's own rule: every change of a shape has a version number, and
  the later one wins. On a tie, every copy picks the same one. All copies end
  on the same drawing, in whatever order the changes arrive.
- What you are dragging, resizing or typing in stays as you have it until
  you let go.
- A change made by someone else doesn't go into your undo history: ⌘Z / Ctrl+Z
  undoes only your own changes.
- A deleted shape is deleted for everyone.

Each person's copy is still saved to their own vault
(`canvases/<name>.excalidraw`). JSON Canvas export and the note cards work as
on a canvas of your own.

## Limits

- Images added to a live canvas are not sent to the others yet. They see the
  frame where the image is.
- The target is 5,000 shapes at 60 frames per second, and a change seen by
  the others within 150 ms (95th percentile). The nightly run measures the
  frame rate on a real computer. The tests measure the delay over a simulated
  relay.
