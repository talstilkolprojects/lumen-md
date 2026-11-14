---
title: Related notes while writing
description: The notes closest to the paragraph you are writing, and the notes it mentions without a link — on this device, without slowing typing.
---

**⌘K → Related notes: show / hide** opens a small panel next to the editor.
While you write it shows:

- **Related** — up to five notes closest to the paragraph at the cursor.
  The paragraph's rarest words are searched with the workspace's BM25
  index (Hebrew prefix letters, full/defective spelling and synonyms
  included). When you built an on-device embedding index (Ollama or the
  in-browser model), its results are blended in. A cloud embedding index
  is never used here, so typing sends nothing anywhere. Click a note to
  open it.
- **Mentioned, not linked** — note names that appear in the paragraph
  without a `[[link]]`. They are underlined (dotted) in the editor. **Link**
  turns that mention into `[[Name]]` (or `[[Name|as you wrote it]]`) as one
  edit that Undo takes back. A Hebrew prefix letter stays outside the
  link. The word you are typing is left alone until you move on.

## It never gets in the way of typing

Nothing runs on a keystroke. The panel updates 100 ms after you stop
typing or move the cursor, and ranking a paragraph against 10,000 notes
takes a few milliseconds, so it is up to date well within 150 ms. Your
text changes only when you press **Link**.

## Turning it off

- For **one note**: add `related: false` to its front matter.
- For **a folder**: ⌘K → *Related notes: on / off for this folder* (for the
  folder of the open note; stored on this device).
- Everywhere: close the panel.
