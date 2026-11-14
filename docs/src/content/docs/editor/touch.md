---
title: Touch and phones
description: Using Lumen with a finger or a pen — dragging, touch targets, the notch and the outline sheet — and how each is tested.
---

Lumen works by touch on phones and tablets, in Hebrew and in English.

## Dragging

Everything that drags with a mouse also drags with a finger or a pen:

- **Blocks in the rich editor.** Touch a block to show its handle, press the
  handle, slide, and lift where the block should go.
- **Tabs.** Press and hold a tab for a moment (about 0.4 s) to pick it up,
  slide it along the strip and lift to drop it. A quick swipe still scrolls
  the tab strip.
- **The sidebar edge.** Drag it to make the sidebar narrower or wider.
- **The graph view.** Tap a note's dot to open it; a finger has a wider hit
  area than the cursor.
- **Menus.** The slash menu, the formatting bubble and the AI button react to
  a tap the same way as to a click, and a tap outside closes them.

## Touch targets

On touch screens every button in the title bar, the status bar, toolbars and
the tab strip is at least **44 × 44** points, the size Apple and Google
recommend. The block handle grows to the same size.

## The notch and the home indicator

On phones with a notch or rounded corners Lumen uses the whole screen and
keeps the title bar and the status bar out of the notch, the corners and the
home indicator.

## The outline on a phone

On a narrow screen the outline is a **bottom sheet** instead of a side panel.
Open it from the command palette (*View → Outline*); picking a heading jumps
there and closes the sheet, and the ✕ button closes it too. Closing the
sheet on a phone does not change the side-panel setting on a wider screen.

## How it is tested

`e2e/touch.spec.ts` runs the full journey on an **iPhone 14** and a
**Pixel 7** profile (viewport, pixel ratio, touch input and the mobile user
agent): the safe-area viewport, the 44-pixel check on every control, typing,
the outline sheet, reordering tabs by long press, moving a block by its
handle. Opening a graph node by tap (a finger's wider hit area, no hover
before the tap) is a unit test in `src/__tests__/GraphViewRender.test.tsx`. Both profiles run on Chromium; Safari's
own engine is not part of the local run.
