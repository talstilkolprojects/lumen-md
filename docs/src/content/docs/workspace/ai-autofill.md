---
title: Fill properties with AI — with approval
description: A model proposes the missing properties of a folder's notes; every proposal waits in an approval queue, and nothing is written until you approve it.
---

`⌘K → "AI: Fill Properties for Notes…"` asks for a folder (empty for the
whole workspace) and proposes values for the **properties your notes
already use** — the frontmatter fields that appear in at least two notes.

## How it works

1. **The fields.** Each property's type comes from the values it has in
   the vault (text, number, date, list, checkbox, link). When a property
   uses only a few values (up to 12, like `status: draft / done`), the
   model must pick one of them.
2. **The answer is constrained.** The `autofiller` agent answers with JSON
   that must match a JSON Schema built for the request: only those
   properties, each with its type and allowed values. An answer that
   doesn't match is sent back once with the reason; a note whose answer
   still fails is skipped.
3. **Only missing values.** A property the note already has is kept; only
   missing or empty ones are proposed.
4. **The approval queue.** Each note's proposal shows every property's
   *before → after*. **Approve** writes that note, **Approve all** writes
   every one, **Reject** drops it. Nothing is written before that. The
   write changes only the proposed values — comments, order and quoting in
   the frontmatter stay byte for byte — and a note that changed after the
   proposal is not written.

Notes open in a tab are left out (they may have unsaved edits). The agent
runs through the agent runtime, so under the *local only* policy on a local
model.
