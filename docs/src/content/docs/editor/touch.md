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
---
title: Touch and phones
description: Using Lumen with a finger or a pen — the editing toolbar, swipes, reading long notes, dragging, touch targets, the notch and the outline sheet — and how each is tested.
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

## The editing toolbar

While you type on a phone or a tablet, a row of buttons sits on top of the
on-screen keyboard. It starts with the actions people reach for most:

- **⇥ / ⇤** indent and outdent the line (every selected line, lists
  included);
- **☐** turns the line into a task; tap again to check it, a third time to
  make it plain text again;
- **🔗** makes a link: selected text becomes its label, a selected address
  its target;
- **🖼** inserts a photo or an image from your files, stored in the vault
  like a pasted image;
- **H** makes a heading (tap again for a smaller one), **B** bold, **•** a
  bulleted list, **[[** a link to another note: type a few letters of its
  name and pick it from the list;
- **↶** undoes; **⌄** hides the keyboard.

Each button is one step: one undo takes it back. The row is 44 points high
like every touch target, scrolls sideways when it is longer than the
screen, and in Hebrew starts at the right, with its arrows pointing the way
the text moves.

### Making it yours

Tap **⋯** at the end of the row (or run *Customize the mobile toolbar* from
the command palette) to add actions (italic, numbered list, tag, code,
quote, redo and more), remove them, and move them with the ↑ and ↓ buttons.
**Reset** brings back the default row.

## Swipes

- Swipe in from the **start edge** of the screen for the file list, and from
  the **end edge** for the outline. "Start" follows the language: in Hebrew
  the file list comes in from the right, in English from the left.
- Swipe a panel back towards its edge to close it.

Only a swipe that starts within about 28 pixels of the edge counts, so
selecting text and scrolling a wide table work as before.

## Long notes open for reading

On a phone, a note of 600 words or more opens in reading view, so it's
quick to open and you don't bring up the keyboard by accident. **Tap the
text** to start editing: the editor opens with the cursor on the line you
tapped. Links, checkboxes, buttons and embeds still do what they do. Turn
this off with *Phone: open long notes for reading* in the command palette.

## Fewer taps

Ten common actions, in taps from an open note (a swipe or picking from a
list counts as one; typing a name doesn't):

| Action | Lumen | Obsidian Mobile | In Lumen |
|---|---|---|---|
| Turn a line into a task | 1 | 1 | toolbar ☐ |
| Indent a list item | 1 | 1 | toolbar ⇥ |
| Outdent a list item | 1 | 1 | toolbar ⇤ |
| Link to another note | 2 | 2 | toolbar [[, pick the note |
| Insert a photo | 2 | 2 | toolbar 🖼, pick the photo |
| Make the line a heading | 1 | 2 | toolbar H |
| Bold a word | 2 | 2 | double-tap the word, toolbar B |
| Open the file list | 1 | 1 | swipe in from the start edge |
| Open the outline | 1 | 2 | swipe in from the end edge |
| Start editing a long note at a paragraph | 1 | 2 | tap the paragraph |

The Obsidian Mobile column is counted by hand from its default toolbar and
gestures; it has not yet been measured on a device.

## How it is tested

`e2e/touch.spec.ts` runs the full journey on an **iPhone 14** and a
**Pixel 7** profile (viewport, pixel ratio, touch input and the mobile user
agent): the safe-area viewport, the 44-pixel check on every control, typing,
the outline sheet, reordering tabs by long press, moving a block by its
handle. Opening a graph node by tap (a finger's wider hit area, no hover
before the tap) is a unit test in `src/__tests__/GraphViewRender.test.tsx`. Both profiles run on Chromium; Safari's
own engine is not part of the local run.

`e2e/mobile-native.spec.ts` runs the phone editing journey on the same two
profiles, in Hebrew: the toolbar above the editor and its actions, the
customize sheet, both edge swipes mirrored, a long note opening for reading
and a tap landing on its line, and the time from launch to the last note.
The toolbar's text actions, the swipe rules and the tap-count table are
unit tests in `src/__tests__/mobileNative.test.ts`.
