---
title: Hebrew and right-to-left
description: How Lumen decides the direction of every block — paragraphs, tables, lists, quotes and code — in the editor, the preview, WYSIWYG and the export.
---

Lumen doesn't make a whole note right-to-left or left-to-right. Each block
reads in the direction of **its own** text, so a Hebrew paragraph sits on
the right and the English one after it on the left, in the same note.

| Block | Direction |
| --- | --- |
| Paragraph, heading | Its first strong letter (Hebrew → right-to-left) |
| List, list item, quote | Its own text: a Hebrew list has its markers and indent on the right, its quote bar on the right |
| Table (preview, export) | The table left-to-right; **each cell** by its own text |
| Table (WYSIWYG) | Each cell's paragraph by its own text |
| Code, math | Always left-to-right, even with a Hebrew comment |

The same rules apply in the source editor (line by line), the preview,
WYSIWYG and the HTML export — an exported Hebrew note opens as
`<html lang="he" dir="rtl">` with the same `dir` on every block.

## The workspace in Hebrew

With the interface in Hebrew, the whole workspace is mirrored, the way
Obsidian does it: the toolbar and the status bar start on the right, the
file tree sits on the right and the outline and backlinks on the left,
tabs run from right to left, menus open from their button's right edge,
and floating controls (the AI button, find & replace, notifications) sit
on the left. The source editor and code stay left-to-right.

The arrow keys keep their visual meaning: **←** moves to what is drawn on
the left. In the Hebrew tab strip that is the next tab; in the welcome tour
← is "next". Home and End go to the first and the last tab.

## Tested

`e2e/rtl-matrix.spec.ts` checks tables, bulleted, numbered, nested and task
lists, quotes and code in the preview, WYSIWYG and the export, with the
interface in Hebrew and in English, in Chromium, Firefox and WebKit, and on
an iPhone 14 and a Pixel 7. `visual/rtl.visual.ts` keeps pixel baselines of
the same note (see [Visual regression](/contributing/visual-regression/)).

`e2e/rtl-parity.spec.ts` checks 20 workspace scenarios in both interface
languages and runs axe on the Hebrew workspace; `src/__tests__/rtlLogical.test.ts`
fails when app CSS, an inline style or a Tailwind class uses a physical
left / right instead of the logical start / end.
