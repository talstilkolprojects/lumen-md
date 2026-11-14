---
title: Workspace search (BM25 + Smart)
description: Fast keyword search by default, semantic embeddings on demand.
---

`⌘K → Search workspace…` opens the workspace search dialog (the palette
shows `⇧⌘F` next to it, but that key toggles focus mode today). Three tabs:

## Search (BM25)

The default: keyword and filename search across every `.md` / `.txt`
note in your workspace, ranked by BM25. Agents use the same search
(`search_workspace`).

- Hebrew-aware: niqqud, final letters (ם/מ, ן/נ…) and the prefix letters
  ו ה ב כ ל מ ש are folded, so *בבית*, *והבית* and *הַבַּיִת* all find
  *בית*. The exact form you typed still ranks first.
- Full and defective spelling meet: *תכנית* finds *תוכנית*, *צהרים* finds
  *צהריים*, *ראיון* finds *ריאיון* (the exact spelling still ranks first).
- Other forms of a word count too, a little less: *אבודות* finds *אבודה*,
  *מזרחנים* finds *מזורחן* (plural, construct and possessive endings).
- A few common synonyms are searched along (*טלפון* / *סמארטפון*,
  *רכב* / *מכונית*, *פגישה* / *ישיבה*…), and common Hebrew words also
  look for their English equivalent, so *מתכון לעוגת שוקולד* finds an
  English *chocolate cake recipe* note — after the Hebrew notes.
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

Measured by `src/__tests__/hebrewSearch.test.ts` on the probe set
`eval/probes/hebrew-search.json` (30 morphology queries, 30 full/defective
spelling pairs, 5 Hebrew→English queries) and on the HeQ dev split, which
must not drop.

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

## Cross-language: ask in Hebrew, find English sources

With the built-in embedding model (multilingual-e5-small, MIT, runs on this
device), **Smart** search finds English notes, papers and clippings for a
Hebrew question. Hebrew and English land in the same vector space, and BM25
adds its Hebrew→English word list. Each hit in another language than the
question shows a local translation under the original:

- from the local translation engine, when one is installed;
- otherwise from the browser's own on-device translator (Chrome), and only
  when the language pair is already on the device. A search never starts a
  download.
- With neither, the original is shown and the dialog says so. Nothing is
  sent anywhere.

Two limits:
- The Ollama embedding model `nomic-embed-text` is English-only. With it,
  Hebrew questions reach English notes only through keywords, and the dialog
  says so.
- On a 10,000-note vault, ranking takes about 15 ms. Embedding the question
  comes on top of that.

How it is measured:
- `eval/probes/crosslingual-he-en.json` has 50 Hebrew questions over 50
  English research abstracts, written for this repository. Its numbers are
  development numbers. On it, BM25 alone reaches nDCG@10 0.18.
- `npm run eval:crosslingual` measures BM25, e5 and the fusion with the real
  model.
- The held-out check is Belebele questions in Hebrew (heb_Hebr) over its
  English passages (eng_Latn), built locally: Belebele's FLORES text is not
  committed. Pass that split with `LUMEN_EVAL_XL_FILES`.

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
