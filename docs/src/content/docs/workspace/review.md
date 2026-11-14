---
title: Daily review (spaced repetition)
description: Review your highlights and question::answer cards a few minutes a day, scheduled by FSRS, with everything kept in the vault.
---

**Command palette → Daily review** shows today's cards, 5–10 at a time. Each
one comes back just before you would forget it.

## What becomes a card

- **Highlights** from PDFs, books and clipped pages: the same ones as in
  [All highlights](/workspace/highlights/). The card shows the passage; the
  back shows its note and where it is from.
- **Question::answer lines** in any note, one per line:

  ```md
  What does FSRS stand for? :: Free Spaced Repetition Scheduler
  מה בירת צרפת? :: פריז
  ```

  The question needs a space in it or must end with a question mark, so
  Dataview-style fields such as `status:: done` are not cards. Lines in code
  blocks are skipped.

## Reviewing

Read the card and recall it. Press **space** (or the button) to see the
answer, then rate how it went: **1 Again**, **2 Hard**, **3 Good**, **4
Easy**, by key or by button. The name of the source opens the note or the
highlight. Each review has the cards that are due, most overdue first, then
up to 5 new ones a day.

## Where it is kept

The schedule of every card is in `.lumen/review.json` in your vault, so it
syncs with the vault and moves with it to another device. Editing a card's
text in its note keeps its schedule. A card whose highlight or line was
removed stays in the file, with its history, but is no longer shown.

Scheduling is FSRS-5 with its default parameters, asking for 90% recall at
each review.
