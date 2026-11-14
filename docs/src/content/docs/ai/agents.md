---
title: Auto-tag + link suggestions
description: AI assistants that read your workspace and propose structure.
---

Lumen ships two opt-in agents that scan a note (and the rest of your
workspace) and suggest improvements. Both run from `⌘K`.

## Auto-tag this note

Command: `🏷️ Auto-tag this note`.

The agent reads the active document, looks at the existing `tags:`
vocabulary across every note in your workspace, and proposes 3–7 tags
that fit. You see the proposals first — accept, edit the list, or skip.
Accepted tags merge into the note's frontmatter idempotently (existing
tags are preserved).

**Why workspace-aware**: a fresh note about machine learning shouldn't
get a brand-new `ml` tag if you already use `machine-learning`
elsewhere. The agent prefers existing tokens and only invents new ones
when nothing fits.

## Suggest wiki-links

Command: `🔗 Suggest wiki-links`.

For each phrase in the active note that overlaps with the title or
intro of another note, the agent proposes wrapping the phrase in a
`[[Title|phrase]]` wiki-link. You review the list (each suggestion comes
with a one-line "why") and accept all / none.

Only literal substrings that already appear in your note become links —
the agent never invents prose. Phrases already inside a wiki-link or
markdown link are skipped automatically.

## Ask Workspace

Inside `⌘K → Search workspace…` → **Ask Workspace** tab. Hybrid retrieval
over your notes plus a chat model on top of the matched context. Multi-turn — the
conversation persists for the open dialog.

## Privacy

All three agents go through the same `chat()` pipeline and respect the
**Local AI** toggle (`⌘K → Switch to local AI (WebGPU)`) and the
[AI policy](/ai/privacy/). When local AI is on, prompts stay on your device — `web-llm` runs the model via WebGPU and
the workspace never leaves your browser.
