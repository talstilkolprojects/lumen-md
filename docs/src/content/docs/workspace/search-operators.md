---
title: Search operators and #tags
description: Narrow a search with tag:, path:, "phrases", /regex/ and -exclusions; tags written in the text count like front-matter tags.
---

The search dialog (`⇧⌘F`) and the agents' `search_workspace` tool read the
same operators. Mix them freely with ordinary words. Every operator must
hold (AND), and the words rank the notes that are left.

| Operator | Finds notes… | Example |
|---|---|---|
| `tag:name` | with this tag, in the front matter or as `#name` in the text. `tag:a` also matches nested `#a/b` | `tag:project` |
| `path:text` | whose path contains *text* (any case) | `path:daily/` |
| `"a phrase"` | that contain the phrase as written (any case; Hebrew ignores niqqud) | `"launch plan"` |
| `/regex/flags` | whose text matches the regular expression; flags `i m s u` | `/^TODO:/m` |
| `-anything` | that do **not** match it: `-tag:archive`, `-path:daily`, `-"draft"`, `-/x/`, `-word` | `tag:project -tag:archive` |

A query made only of operators lists the matching notes, newest first,
with the snippet on the match. A `/regex/` that doesn't compile returns no
notes; it never falls back to returning every note.

## Tags in the text

`#tag` anywhere in a note counts as a tag, like `tags:` in the front matter,
in the Tags panel and for `tag:`.

- Letters of any script count: `#פגישות` is a tag.
- `/` nests tags: `#meeting/standup`.
- These are **not** tags: headings (`# Title`), anything in code
  (`` `#x` `` or a fenced block), numbers such as `#42`, and URL fragments
  (`page#section`).

## How it is tested

`src/__tests__/searchOps.test.ts` runs 30 operator queries on a fixed
12-note vault (English, Hebrew, nested tags, tags in code), each checked
against the exact set of notes it must return. The queries run through the
same index the dialog uses.
