---
title: Slides from notes and the canvas
description: Present a note or a canvas as slides, right to left when it's Hebrew, with speaker notes, a presenter view on a second screen, and PDF export.
---

## From a note

Open the note and run `⌘K → "▶ Present this note as slides"`. The show
starts from the slide where the cursor is.

- An `#` or `##` heading starts a slide, and a `---` line (or `***`) ends
  one. You can use both in the same note. Lines inside code blocks never
  split.
- **Speaker notes**: everything from a line starting with `Note:`,
  `Notes:` or `הערות:` to the end of the slide, or anything inside
  `<!-- notes … -->`. Notes are never shown on the slide.
- **Direction**: each slide follows its own text, so a Hebrew slide is
  right to left. To fix one direction for the whole deck, add `dir: rtl`
  or `dir: ltr` to the frontmatter.

## From the canvas

**Present** in the canvas bar shows the canvas one frame at a time.

- Every Excalidraw frame is a slide.
- Arrows between frames set the order: an arrow from frame A to frame B
  makes B come after A.
- Frames that no arrow points to start the order, in reading order: top to
  bottom, then right to left on a Hebrew canvas and left to right
  otherwise.
- A text in a frame that starts with `Note:` or `הערות:` is that slide's
  speaker notes and isn't shown.
- Slides are drawn with the same Hebrew fixes as the canvas's
  [SVG export](/workspace/canvas-cards/), and note cards show their notes.

## Presenting

| Key | |
|---|---|
| `→` / `←` | Next / previous, following the deck's direction: on a Hebrew deck `←` goes forward, as in a Hebrew book |
| `Space`, `PageDown`, `↓` | Next |
| `PageUp`, `↑`, `Backspace` | Previous |
| `Home` / `End` | First / last slide |
| `Esc` | End the show |

Every slide is prepared before the show starts, so changing slides takes
under 50 ms.

**Presenter view** opens a second window with the current and next slide,
the speaker notes and a timer; its buttons and arrow keys move the show.
In the desktop app with a second screen connected, the slides go full
screen on the other screen and the presenter view stays on yours. In the
browser it's a pop-up window.

**PDF** prints every slide on its own landscape page; choose "Save as
PDF". The text stays text, in its own direction.
