---
title: AI cost — usage meter and answer cache
description: See what your AI requests cost, and avoid paying twice for the same answer.
---

Lumen calls the AI provider you choose with your own API key. Two
features keep that bill visible and small. Both run locally on your
device.

## Usage meter

Command: `AI: Usage & Cost This Month` (`⌘K`).

For the current month it lists requests, input and output tokens, and an
estimated cost per provider and model.

- **Exact counts** come from the provider whenever its API reports them:
  OpenAI, Claude (including prompt-cache reads and writes), Gemini and
  Mistral, both for regular and streamed answers.
- **Estimated counts** (about 4 characters per token) are used when the
  provider reports nothing, and are marked as estimated.
- **Local models** (Ollama, in-browser WebGPU) are counted at $0.
- **Prices** come from a built-in table of list prices, dated in the
  report. Treat them as an estimate; your provider's dashboard is the
  real bill. Models missing from the table are counted but not priced.

Usage stays in this browser's storage. It isn't synced and is never sent
anywhere.

## Answer cache

Command: `AI: Answer Cache…`.

Some commands transform a given text deterministically: auto-tag,
translate, diagram from text, action items, chart from data and heading
suggestions. When you run one of them again on exactly the same input
with the same provider and model, Lumen reuses the stored answer
instead of paying for a new one. Cache hits appear in the usage report.

- Change the text, the model or the provider and the request goes to the
  model again.
- Answers expire after 30 days. At most 500 are kept, and the oldest are
  dropped first.
- From the command you can turn the cache off (every request then asks
  the model) or clear it.
- Cached answers are stored in this browser's IndexedDB, on this device
  only.

## Claude prompt caching

With Claude, long system prompts and long documents sent as context
(about 8,000 characters or more) are marked for Anthropic's prompt cache.
A follow-up request on the same document within about five minutes reads
that prefix at roughly 10% of the normal input price. The usage report
shows these cache reads separately.

## Cost mode

Command: `AI: Cost Mode (Economy / Balanced / Quality)…`.

| Mode | Small tasks¹ | Other requests | Context per question² |
|---|---|---|---|
| Economy | Small model | Small model | ~2,000 tokens |
| Balanced (default) | Small model | Your chosen model | ~5,000 tokens |
| Quality | Your chosen model | Your chosen model | ~12,000 tokens |

¹ Tags, heading suggestions, completions and commit messages. The small
models are GPT-4o mini, Claude Haiku 5.5, Gemini 2.5 Flash and Mistral
Small. Local providers (Ollama, WebGPU) are never rerouted, and a
request that names its own model is left alone.

² **Ask Workspace** reads the matching notes in full, then sends only
the parts relevant to your question. Each note is split at its
headings, the sections are ranked against the question (BM25), and the
best ones are kept within the budget. Every note also sends its heading
outline, so the model still sees how it is structured. Notes that
already fit are sent unchanged.

## Batch over a folder (half price)

Command: `AI: Batch over a Folder (half price)…`, then `AI: Check Batch Jobs`.

To tag, summarise or translate many notes, Lumen sends them as one job to
the provider's batch API: OpenAI's Batch API or Anthropic's Message
Batches. Both charge half the normal price and return results within
24 hours.

1. Pick what to do (tags, a one-line `summary` in the front matter, or
   a translation into a new `name.<language>.md` file next to each note)
   and which folder to process.
2. Lumen shows the number of notes and an estimated cost before
   anything is sent. Each note counts as one AI prompt against your
   plan's quota.
3. Later, run `AI: Check Batch Jobs`. When a job has finished, Lumen
   shows how many notes will change and how many files will be created,
   and applies the changes only after you confirm. Notes that are open
   in a tab are skipped, and existing files are never overwritten by a
   translation.

Batch jobs need the OpenAI or Anthropic provider. Their usage appears
in the usage report at batch prices.

### Known limitations — status

| Id | Limitation | Status |
|---|---|---|
| A9 | A retry after a failure saving the job's state could write one duplicate translation | Fixed. Each translation carries its job's marker, and a retry looks for it among all `name.<language>-N.md` files of the note, so deleting a lower-numbered copy in between no longer leads to a second copy. |
