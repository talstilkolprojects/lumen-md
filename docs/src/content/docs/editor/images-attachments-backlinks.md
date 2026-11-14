---
title: Images, attachments, copy and backlinks
description: Resize an image by dragging, reset it with a double-click, delete a note's own attachments with it, copy as formatted text, and search the backlinks.
---

Four everyday actions people moving from Obsidian 1.12 or Heptabase expect. All of them work
on this device only.

## Resize an image

In the preview, drag the image's inline-end edge (the right edge in English, the left edge in
Hebrew). On release the width is written to the note: `![[photo.png]]` becomes
`![[photo.png|300]]`, and `![alt](photo.png)` becomes `![alt|300](photo.png)`.

**Double-click the same edge** to take the size off again: the note goes back to
`![[photo.png]]` and the image to its own size. Other parameters (`![[photo.png|A caption|300]]`)
are kept.

## Delete a note's attachments with it

When you delete a note (or a folder) from the file tree, Lumen looks for the attachments that
**only** what you are deleting links to: images, PDFs and other files. Then, as the setting
says:

- **Ask each time** (the default): a dialog lists them. Choose to move them to the trash too,
  keep them, or decide once and for all.
- **Move them to the trash too**: no question.
- **Keep them**: attachments are never touched.

The setting is at the bottom of the **Trash** panel. An attachment that any other note, canvas
or base file links to, or even names in its text, is never offered. A name that two files
share (`photo.png` in two folders) keeps both.

Everything goes to the trash in one step, so the toast's **Undo** or one **Ctrl+Z** brings
back the note and its attachments together, and the Trash panel can restore them for 30 days.

## Copy as formatted text

Copying from the source editor now puts two things on the clipboard: the Markdown as plain
text, and an HTML rendering. Paste into Word, Google Docs or an email and the headings, bold,
italics, lists, links, quotes and code blocks stay. Each paragraph carries its direction
(`dir="rtl"` for Hebrew, `dir="ltr"` for English), so a mixed note pastes the right way round.
Pasting into a plain-text field or another Markdown app still gives the Markdown.

**Copy image**: right-click an image embed (`![[photo.png]]`) in the source editor and choose
**Copy image**. The image goes to the clipboard as PNG. Shift+right-click opens the browser's
own menu.

## Search, sort and fold the backlinks

The backlinks panel groups the links by the note they come from, with a count for each.

- **Search** filters by the note's name or path, or by the text around the link. Case and
  niqqud don't matter.
- **Sort** by name or by when the note was last modified (newest first). The choice is kept
  on this device.
- Click a note's name to **fold** it; **Collapse all** / **Expand all** fold every group.

The workspace search (**⌘K → Search workspace…**) also finds text inside code blocks and inside list
items that are folded in the editor: folding only hides them on screen.
