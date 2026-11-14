---
title: Automatic merging
description: When the same note changed in two places, Lumen merges the two edits itself and asks only when both changed the same words — the same way for encrypted sync, git and edits made outside Lumen.
---

A note can change in two places at once: on your laptop and your phone
between two syncs, in Lumen and in a `git pull`, or in Lumen and in another
editor working on the same folder. Lumen merges both edits on its own, keeps
both versions in the note's history, and opens the conflict dialog only for
the part both sides changed in different ways.

## How the merge works

Lumen compares each version with the last one both sides had:

1. **Front matter, key by key.** A field one side changed takes that change.
   When both sides changed a list — `tags`, `aliases` — both sets of
   additions and removals are applied (`[a, b]` + `c` here, `d` there →
   `[a, b, c, d]`). The same field changed to two different values is a
   conflict. The merged front matter must be valid YAML; if it would not be,
   Lumen does not merge it.
2. **The body, line by line.** Lines only one side touched take that side's
   version.
3. **Then word by word.** If both sides edited the same line or paragraph —
   one fixed a typo, the other added a word — both edits are kept.
4. **What is left asks.** Only when both sides changed the *same words*
   differently (or one deleted what the other edited) does the conflict
   dialog open, showing just those places.

Nothing is lost: both versions go into the note's **history** (marked *kept
at a merge*), so any merge can be undone from the version list.

## Where it applies

| Where | What happens |
|---|---|
| [Encrypted sync](/sync/e2ee/) | A note both devices changed is merged before the dialog; binary files are kept side by side. |
| [Git](/sync/git/) | A pull merges the files both sides changed; what still overlaps gets the usual conflict markers for the resolution screen. |
| Changes outside Lumen | A note with unsaved edits that another app changed on disk is merged into the editor and saved; if you keep typing while it merges, the dialog decides instead. |

All three use the same merge engine (`src/sync/merge/textMerge.ts`).

## How often it merges by itself

In the test of 500 random pairs of concurrent edits to ordinary notes (a
few word changes, new lines, deleted lines, new tags and changed fields on
each side), 459 merge without a dialog (92%), every word either side added
is in the result, and the front matter is valid YAML in every merge.
