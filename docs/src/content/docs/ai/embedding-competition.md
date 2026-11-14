---
title: Choosing the Hebrew search model
description: How Lumen picks the model behind semantic search and suggested links. It runs a competition on a hard Hebrew question set, and the default changes only for a clear, measured gain.
---

Semantic search and suggested links depend on an *embedding model*. In 2026
three small multilingual models with open licences came out, and the old
question set could not tell them apart: plain word search (BM25) already scored
a perfect 1.0 on it.

## The hard set

300 Hebrew questions from HeQ, each rewritten the way people really ask:

| Rewrite | Example |
| --- | --- |
| paraphrase | `מתי נולד` → `באיזו שנה נולד` |
| inflection | a prefix added or dropped (`ו ה ב ל מ ש כ`), plural ↔ singular |
| spelling | full ↔ defective (`כתיב מלא/חסר`) |
| acronym | `צה״ל` ↔ `צבא ההגנה לישראל` |
| loanword | `מחשב` ↔ `קומפיוטר`, `תוכנה` ↔ `software` |

30% of the questions are held out and used only for the final decision. The
cross-lingual questions of the Hebrew→English probe are measured too.

## The candidates and the rules

The candidates are multilingual-e5-small (the current model), EmbeddingGemma 2
(also cut to 256 dimensions, which halves the index of a large vault),
Qwen3-Embedding-0.6B and, as a reranker, Qwen3-Reranker-0.6B. Each is measured
for nDCG@10, Recall@20, time per query, download size and index size.

- The set is valid only if it separates the best and worst model by at least 5 nDCG@10 points.
- The default changes only for at least **5 points** on the held-out part, and only if a query
  takes at most **150 ms** on 10,000 notes on an average computer.
- The reranker is turned on only if it adds at least **3 points**; otherwise it stays off.
- Every model needs a checked licence, a sha256 and a mirror before Lumen downloads it.
