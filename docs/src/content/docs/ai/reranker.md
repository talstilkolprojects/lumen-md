---
title: Search reranking — measured
description: What the search reranker adds on Lumen's retrieval golden set, the decision that follows, and how to measure the model yourself.
---

Search ranks with BM25 (and, in smart search, embeddings). A **reranker**
then reorders the best candidates by reading the query and each candidate
together. Lumen has two:

| Reranker | Where | Default |
|---|---|---|
| built-in (lexical) | every device; Hebrew-aware word coverage blended with the retrieval rank; no download | on |
| model: `bge-reranker-v2-m3` (Apache-2.0) | WebGPU browsers and the desktop app only; a one-time download of about 571 MB (q8), after you agree | **off** |

`jina-reranker-v2` is not used (its licence is non-commercial), and
mMiniLM rerankers don't cover Hebrew.

## The measurement

On the retrieval golden set (plan 7.1, `eval/golden/retrieval`), HeQ dev
split — 12 Hebrew questions over 238 paragraphs, 20 BM25 candidates each,
nDCG@10:

| | nDCG@10 |
|---|---|
| BM25 alone | 1.0000 |
| BM25 + built-in reranker | 1.0000 |

BM25 already puts every answer first on this split, so no reranker can add
the 5 points the plan asks for: **the model reranker stays off by default**
and is offered only where it runs fast, after consent. The cross-lingual
part (Belebele, an English question over Hebrew passages, where BM25 can't
match and a reranker might help) and the held-out test split are measured
with the model by:

```sh
npm run eval:rerank
# with the held-out split and Belebele built:
LUMEN_EVAL_RERANK_DIRS=eval/golden/retrieval/dev,<test split dir> npm run eval:rerank
```

It writes `eval/results/rerank-<date>.md` with BM25, BM25 + the model and the
gain per part, and the decision the plan's rule gives (< 5 points: off by
default).
