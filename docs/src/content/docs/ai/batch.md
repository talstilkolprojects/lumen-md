---
title: Batch jobs — pause, resume, progress
description: Run tags, summaries or translations over a folder on this device, watch the progress live, and pause, resume or cancel the job — also after a reload.
---

`AI: Batch over a Folder…` tags, summarises or translates every note in a
folder. Under the *local only* and *local first* policies the job runs on
this device (Ollama, or the in-browser model), one note at a time in the
background; under *cloud* with OpenAI or Anthropic it goes to their
half-price Batch API (see [AI cost](/ai/cost/)).

## The batch jobs panel

`⌘K → "AI: Batch Jobs — Progress, Pause, Resume"` (it also opens by itself
after you submit a local job) lists every job that hasn't been applied:

| What you see | What it means |
|---|---|
| progress bar and "*n* of *total* done · *k* failed" | live, after every note |
| "About … left" | the average time of the last notes × the notes still to go |
| **Pause** | the note being processed stops (it runs again on Resume) and nothing else starts. The pause is saved: after a reload or a restart the job is still paused, and "AI: Check Batch Jobs" doesn't restart it. |
| **Resume** | continues from the first note without an answer — notes already answered are never sent again |
| **Cancel job** | stops the job (a cloud job is cancelled at the provider); none of its results is applied |
| "Waiting for a local model" | no Ollama and no in-browser model was available; Resume tries again |
| **Apply results** | when the job has finished: the same review as "AI: Check Batch Jobs" — notes open in a tab are skipped and you confirm before anything is written |

## Every answer is checked

Each job has a validator for its operation, and an answer that fails goes
to the agent runtime's critic, which retries once with the reason as a hint:

| Operation | The answer must be |
|---|---|
| Tags | a JSON array (or comma list) of 1–10 short tags |
| Summary | one or two plain sentences — no headings, lists or quotes, and shorter than the note |
| Translate | not the source text back, and of a plausible length (not a fraction of the note, not three times it) |

A note whose answer still fails is counted as *failed* with its reason —
listed under "Rejected answers" in the panel — and is never written.
