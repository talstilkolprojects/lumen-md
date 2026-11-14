---
title: Local LLM (web-llm + WebGPU)
description: Run AI prompts entirely on your device — private, offline-capable, no per-token cost.
---

Lumen routes every AI command through `chat()`. With `useLocalAi`
toggled on (and a WebGPU-capable browser), prompts go to a model
running in your tab via [web-llm](https://github.com/mlc-ai/web-llm) —
nothing leaves the machine.

## Switch on

```
⌘K → "Switch to local AI (WebGPU)"
```

The first prompt downloads a model **sized for this device** — the
model manager probes the GPU (WebGPU, `shader-f16`, device memory) and
picks the largest model of the task's tier that fits, from about 0.4 GB
(SmolLM2 360M) to 6 GB (Qwen3 8B, Gemma 2 9B). Pick one yourself with
`⌘K → "AI: Local Models (WebGPU)"`, which also shows what is already
downloaded and lets you download a model ahead of time. Weights are
cached in the browser; later prompts start instantly.

Inference runs in a **Web Worker**, so the editor stays responsive
while a model loads or generates, and a toast reports download progress
at 5 % intervals.

Firefox on Linux and Android browsers have no WebGPU yet: there the
in-browser model is off and the AI settings say so; use Ollama instead.
The settings also show how much browser storage the models take and
clear it (see [Model manager](/ai/local-agents/#model-manager)).

## When to use it

- You're on a plane / café / corporate network without API access.
- The note contains secrets you don't want to put into a hosted LLM.
- You want predictable cost — local inference is free after the
  one-time download.

## When not to use it

- Long-context tasks (>4k tokens) — the 8B model loses coherence.
- Latency-sensitive flows — local inference is ≈ 5–10× slower than
  GPT-4o-mini for the first token.
- Older laptops — the model needs ≥ 4 GB of GPU memory.

## How to fall back

What happens when WebGPU (or Ollama) isn't available depends on your
**AI policy** (`⌘K → "AI: Local or Cloud Policy"`):

- **Local only** (the default on a fresh install): nothing leaves the
  device. The command stops with a clear message and the agent's
  suggestions (start Ollama, pick a smaller model, use a WebGPU browser).
- **Local first**: a reachable Ollama server answers first (also when a
  cloud provider is selected); in-browser WebGPU takes the request when
  Privacy Mode is on; only then the cloud provider with your key. An
  installation that had only a cloud key before policies existed keeps
  this behaviour until you choose.
- **Cloud**: the selected cloud provider is used directly. An
  installation that had a cloud provider selected before policies
  existed starts here.

Under **Local only** every other path that would send content to a third
party stops as well: smart-search embeddings, Whisper transcription,
batch jobs, fine-tuning, Claude web search, a remote research service and
the public LanguageTool API (a LanguageTool or SearXNG on this machine or
network is fine).

See [Local agents](/ai/local-agents/) for how every AI command runs
through the local agent runtime.

## Pick a different model

`⌘K → "AI: Local Models (WebGPU)"` lists the curated catalog for this GPU
(size, tier, downloaded, recommended). "Automatic" lets the model manager
choose per task: small models for tags and completions, larger ones for
translation and documents, Hermes (function calling) when an agent needs
tools, Qwen2.5 Coder for the product builder.

## Privacy claim

When `useLocalAi` is on AND `localLlmAvailable().available === true`,
prompts never leave your tab. The only network requests web-llm makes
are the initial weight downloads (from `huggingface.co` mirrors) plus
optional telemetry that you can disable. No prompt content is
transmitted.
