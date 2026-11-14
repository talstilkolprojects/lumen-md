---
title: Workspace search (BM25 + Smart)
description: Fast keyword search by default, semantic embeddings on demand.
---

`⌘K → Search workspace…` opens the workspace search dialog (the palette
shows `⇧⌘F` next to it, but that key toggles focus mode today). Three tabs:

## Search (BM25)

The default — instant keyword + filename search across every `.md` /
`.txt` in your OPFS workspace. Built on BM25+ with bigram phrase
matching, runs in a Web Worker so the UI never stalls.

- File-name match scores higher than body match.
- Highlights the matched substring inside a 160-char snippet.
- Returns the top 40 hits ordered by relevance.

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
