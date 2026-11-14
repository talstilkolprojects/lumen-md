---
title: Direction marks (bidi)
description: See the invisible characters that set text direction, clean the ones that do nothing, fix reversed brackets, and catch Trojan Source text.
---

Hebrew and Arabic text pasted from a word processor, a web page or a chat
app often carries characters you cannot see. They set the direction of the
text around them, and they are the usual reason a pasted paragraph suddenly
runs the wrong way or a bracket jumps to the other end of the line. Lumen
shows them, removes the ones that do nothing, and warns you about the
dangerous ones.

## Show direction marks

Command palette (⌘K) → **Show direction marks**. Every direction control
gets a small tag in front of it, in the source editor and in WYSIWYG:

| Tag | Name | What it does |
| --- | --- | --- |
| `LRM` `RLM` `ALM` | left-to-right, right-to-left, Arabic letter mark | an invisible letter of that direction; pins a line that starts with a number or a Latin word |
| `LRE` `RLE` … `PDF` | embeddings | lay out the text up to `PDF` in that direction |
| `LRO` `RLO` … `PDF` | overrides | force every character up to `PDF` into that order, even Hebrew letters |
| `LRI` `RLI` `FSI` … `PDI` | isolates | lay out a run (a URL, a name) on its own, without disturbing the line |

The character stays where it is, so the line lays out exactly as it does
anywhere else. The tag only shows you why. Run the command again to hide the
tags. The setting is kept on this device.

## Clean direction marks and fix brackets

Command palette → **Clean direction marks and fix brackets** does two things
as **one** change, so a single Undo (⌘Z) brings everything back:

- **Removes marks that change nothing on screen.** These are decided by the
  Unicode bidi algorithm (UAX #9), not guessed:
  - an `RLM` right before a Hebrew letter, or right after one;
  - an `LRM` right before or right after a Latin letter;
  - an `ALM` right after an Arabic letter;
  - an embedding or isolate with nothing inside;
  - a `PDF` or `PDI` that closes nothing.

  A mark that does change the display stays. Examples are the `RLM` in front
  of `10:30 פגישה`, an `LRM` after a number, and an `RLM` after Arabic text,
  which changes how the digits after it are read. Overrides always stay too.
- **Swaps brackets typed backwards in right-to-left lines.** `)טקסט(` was
  typed that way so it would look right in a program that did not handle
  direction. When every bracket of one kind in a line is backwards, and
  swapping them balances the line, they are swapped. Smileys (`:)`), list
  numbers (`1)`), links and left-to-right lines are left alone.

Fenced code and code spans are never changed.

## The paste warning (Trojan Source)

Two things make text display in an order other than the one it is stored in:

- an **override** (`LRO`, `RLO`);
- an embedding or isolate **left open** at the end of its line.

What you read is then not what a search, a diff or a compiler sees. This is
the "Trojan Source" attack (CVE-2021-42574).

Lumen tags these characters in **red** whether or not the marks are shown.
When you paste or drop text that contains them, a warning appears with a
**Remove them** button. The button deletes only those characters, as one
undoable change, so the text displays in the order it is stored. Harmless
isolates and marks stay.

## Limits

- **Lines are checked one at a time.** An isolate opened on one line and
  closed on the next counts as left open, as it does in the browser.
- **Only these 12 controls are covered.** Zero-width joiners and
  non-joiners are not direction controls and are not shown.
