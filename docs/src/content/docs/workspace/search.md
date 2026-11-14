---
title: Workspace search (BM25 + Smart)
description: Fast keyword search by default, semantic embeddings on demand.
---

`⇧⌘F` opens the workspace search dialog. Three tabs:

## Search (BM25)

The default: keyword and filename search across every `.md` / `.txt`
note in your workspace, ranked by BM25. Agents use the same search
(`search_workspace`).

- Hebrew-aware: niqqud, final letters (ם/מ, ן/נ…) and the prefix letters
  ו ה ב כ ל מ ש are folded, so *בבית*, *והבית* and *הַבַּיִת* all find
  *בית*. The exact form you typed still ranks first.
- Question words (*מתי*, *איפה*, *למי*, *what*, *when*…) don't count, so
  you can type a question.
- A match in the note's name counts more than one in its text, and the
  whole query found as a phrase counts extra.
- The index is built on the first search and then updated one note at a
  time as you save; a 10 000-note vault answers in a few tens of
  milliseconds.
- Each hit shows a snippet with the match highlighted; the top 40 are
  listed.
- Operators narrow the search: `tag:`, `path:`, `"phrase"`, `/regex/` and
  `-` to exclude. See [Search operators and #tags](/workspace/search-operators/).

## Smart (semantic)

Hybrid retrieval that fuses BM25 with cosine similarity over OpenAI
`text-embedding-3-small` vectors via Reciprocal Rank Fusion (RRF, k = 60).
Finds notes that are semantically related even when the surface words
don't match — a query for *"deep learning"* surfaces a note titled
*"Neural networks"*.

To enable:

1. Switch to the **Smart** tab.
2. Click **Build index** (one-time, then incremental on subsequent runs).
3. Type your query — results re-rank in real time.

**Cost**: each chunk is embedded once and cached in IndexedDB. A 100-note
workspace embeds in ≈ 8s and ≈ 200 K tokens (≈ $0.004 with
`text-embedding-3-small`). Re-indexing only re-embeds chunks whose hash
changed.

## Ask Workspace (RAG Q&A)

Type a question, hit Enter — the dialog runs Smart search to find
relevant notes, then sends the top 8 + your question to the configured
chat model. Answers come back with `[1]` / `[2]` citations linked back
to the source notes.

**Use it for**:
- "Summarise everything I've written about onboarding."
- "Which projects mentioned that Q3 launch deadline?"
- "What did I decide about the auth provider?"

The conversation is kept in-dialog — multi-turn follow-ups remember the
prior context.
