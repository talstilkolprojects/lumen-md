---
title: Organize the vault
description: Missing links, tags, duplicates to merge and maps of content for your whole vault — each one a change you approve, with its confidence, reason and a quote.
---

**⌘K → AI: Organize the vault** reads every note and suggests:

| Suggestion | What changes when you approve it |
|---|---|
| **Link** — a note mentions another note's title but does not link to it | The first mention becomes `[[Title]]` (or `[[Title|the words used]]`). A Hebrew prefix letter stays outside the link: `ב[[פרויקט אלפא]]`. Mentions in code, headings, URLs and existing links are left alone. |
| **Tags** — a tag the vault already uses fits a note that lacks it | Up to three tags are added to the note's front matter. Reason: the tag's word is in the note, or the notes it links with have the tag. |
| **Merge** — two notes are near duplicates | The longer note gets the other's extra paragraphs under its title; the other becomes a pointer `→ [[kept note]]`. |
| **Map of content** — a tag has six or more notes and no note links most of them | A new note `maps/<tag>.md` that lists them. |

## Nothing is written without you

The organizer only suggests. The panel shows each suggestion with its
**confidence**, **why**, and a **quote** from the note it is based on.
**Review the next 20** sends a batch to the review screen (the same one
agents use), where each suggestion is a diff with Approve and Reject.
Only Approve writes, and only if the text is still what the organizer
read. Link and tag changes in one note can be approved in any order.

While it reads the vault you can **Pause**, **Resume** or **Cancel**, as
with batch jobs. Cancelling writes nothing.

## It learns what you accept

Every approval and rejection is remembered on this device (IndexedDB,
like the agents' learning critic): kinds of suggestion you approve rise,
ones you reject sink, and a kind you rejected again and again (at least 3
times, under 25% approved) is no longer suggested. A tag you keep
rejecting stops being suggested on its own.

## How it decides

The analysis runs on this device without a model: whole-word title
matches (with Hebrew prefix letters and niqqud handled), the tags of
linked notes, word 5-gram overlap for duplicates. One-word titles that
are ordinary words in your vault ("Notes", "סיכום") are not linked. A
local model can be plugged in to re-score suggestions (`setOrganizerModel`);
none is on by default.
