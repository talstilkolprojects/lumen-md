---
title: Local autocomplete (FIM)
description: Completions as you type from a coding model on this device — Ollama with qwen2.5-coder, or the in-browser model — with no cloud route at all.
---

`⌘K → "AI: Local Autocomplete (FIM) — On/Off"` turns on completions as you
type. A pause of 150 ms after a keystroke sends the text **before and after
the cursor** to a local model, which fills in the middle; the answer
appears in grey at the cursor. **Tab** accepts it, **Esc** dismisses it,
and the next keystroke cancels a request still in flight.

## Where it runs

| Engine | When | Model |
|---|---|---|
| Ollama `/api/generate` with `suffix` | an Ollama on this machine or network has a completion model | `qwen2.5-coder:1.5b`, else `qwen2.5-coder:7b` (Apache-2.0) |
| The in-browser model (web-llm) | no such Ollama, and an in-browser model is already loaded in this tab | the loaded model, through the `completer` agent |
| — | neither | no completion (a keystroke never starts a model download) |

There is no cloud route: autocomplete never contacts a cloud provider,
under any AI policy, and an Ollama on a remote server is not used.
`qwen2.5-coder:3b` is never picked automatically — its licence (Qwen
Research) is not an open one. To use another installed model, set
`lumen.fim.model` in the browser's local storage.

Install the recommended model once:

```sh
ollama pull qwen2.5-coder:1.5b
```

## Speed

Answers are cached per context (the same text around the cursor twice is
answered at once), and the model is kept loaded between keystrokes. The
latency of every completion is kept; its p50 / p95 go to the agent trace
(`⌘K → "AI: Recent Agent Runs"`, agent `fim`) at most every 30 seconds.

`npm run bench:fim` measures it on your Ollama: 20 English, Hebrew and code
contexts × 3 rounds after a warm-up, printing p50 / p95 (`--assert 300`
fails when p50 is not under 300 ms, the target).
