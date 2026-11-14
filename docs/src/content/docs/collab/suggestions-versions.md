---
title: Suggestions and named versions
description: Suggest edits that change nothing until someone accepts them, accept or reject one person's suggestions at a time, see who wrote what (the AI included), and name versions to compare word by word.
---

## Suggesting, alone or together

Turn on **suggesting mode** (track changes) from the command palette. From
then on, what you type and delete is written as a suggestion, and the text
itself doesn't change until someone accepts it:

```md
The report is {++almost ++}{>>@Dana<<}done{--, finally--}{>>@Avi<<}.
```

This works in the source editor and in WYSIWYG, alone and in a shared note.
In a shared note, everyone sees each suggestion as it is made.

## Who suggested what

- Each author's suggestions are underlined in their own colour, and hovering
  shows the name.
- Suggestions the AI made carry the author **AI** and are marked "AI".
- The command palette lists everyone who has a suggestion in the note:
  **Accept all from Dana (3)** and **Reject all from Dana (3)**, and the same
  for each other author, the AI included. These resolve only that person's
  suggestions; everyone else's stay as they are.

## Named versions

In a shared note, open **Named versions…** from the command palette.

- Give the current text a name, such as "Before submission". The version is
  saved inside the shared note, so everyone in it sees the same list. Only
  editors can save a version.
- Pick any two versions, or a version and the current text, to compare them.
  The comparison is word by word: additions are green, removals are red, and
  you see how many words were added and removed.
- The comparison is built for Hebrew. A word keeps its one-letter prefixes
  (ו, ה, ב, ל, מ, ש, כ), its niqqud, and a geresh or gershayim inside it
  (צה״ל), so "הבית" changed to "ובית" shows as one changed word, not one
  changed letter.

## Tested

- Twenty Hebrew comparison cases, covering prefixes, niqqud, gershayim,
  numbers, punctuation and mixed Hebrew and English, are checked on every
  run.
- By-author accept and reject are tested to change only that author's
  suggestions.
- A two-browser test runs through the collaboration server. A participant
  suggests and the owner's text doesn't change. The owner accepts and the
  change lands. A version named by the owner then shows up for the
  participant, with the word-level comparison.
