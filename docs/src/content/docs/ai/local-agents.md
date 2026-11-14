---
title: Local agents
description: Every AI command runs through one local agent runtime — the model proposes, tools execute, validators decide, and an improvement agent steps in when there is no answer.
---

Lumen's AI commands are **agents**: a definition of what to ask the
model, which tools it may call, what shape the answer must have and how
to check it. One runtime (`src/agents/runtime.ts`) runs every definition
against the first available **executor**, on this device whenever it
can:

| Executor | Where it runs | Tool calling | JSON output |
|---|---|---|---|
| Ollama | a local Ollama server | native (`tools`) | native (`format`) |
| web-llm | your browser, on the GPU | JSON-ReAct protocol | JSON mode |
| `chat()` | whatever provider you selected | JSON-ReAct protocol | prompt |

The **AI policy** (`⌘K → "AI: Local or Cloud Policy"`) decides whether a
cloud provider may ever be contacted. The default on a fresh install is
*local only*.

## What a run does

1. Picks the first available executor in the agent's preference order.
2. Sends the system and user prompts. When the agent has tools and the
   executor cannot call them natively, the prompt teaches the JSON-ReAct
   protocol: the model answers `{"tool": …, "args": …}` or
   `{"final": …}`, one JSON object per turn.
3. Executes each tool call. Tools that write or reach the network need a
   permission the command grants explicitly; a model can never write
   where you did not expect.
4. Parses the final answer (JSON when the agent declares a schema) and
   runs the agent's **validators** — a Mermaid diagram must compile, an
   ECharts option needs series and axes, tags must exist, offsets must
   fall inside the text.
5. When there is no usable answer, the **improvement agent** (the
   critic) diagnoses the failure and proposes one change for a retry —
   temperature 0 with the validator's error fed back, then a larger
   model tier — up to two retries. If that still fails, the run ends
   with **suggestions** you can act on: start Ollama, allow the app's
   origin (`OLLAMA_ORIGINS`), pull a model, split the document, try
   another executor, or allow the cloud.
6. When the retries are used up, a small local model (the tiny tier)
   reads the failure and may add one or two suggestions in plain
   language. The suggestions panel opens on its own; pressing a
   suggestion does it (pulls the model, switches the executor, changes
   the policy) and runs the command again.

Every run is recorded on this device: `⌘K → "AI: Recent Agent Runs"`
shows the executor, model, tool calls, retries and failures of the last
50 runs.

## AI settings

`⌘K → "AI: Settings (local agents)"` gathers everything in one panel:

- the AI policy;
- **who runs the agents** — automatic (Ollama → browser → chat provider)
  or one executor first, with a live *available / not available* check
  for each;
- the Ollama address and model, with the models already installed;
- the in-browser model, the device card (WebGPU, f16, a VRAM budget
  estimate) and the catalogue, with models too large for this device
  disabled;
- the grammar (LanguageTool) and research (SearXNG worker) addresses;
- your writing-style profile on/off;
- the last ten agent runs.

The panel writes the same settings the runtime reads; nothing is stored
twice. The VRAM budget is a heuristic from the browser's coarse hints,
not a measurement.

## Model manager

The same panel manages the models themselves:

- **AI mode** — *economy*, *balanced* (the default) or *quality*. For the
  local executors it moves the model tier of the next agent run: economy
  runs one size smaller than the agent asks for (a tagger that wants a
  *small* model gets a *tiny* one), quality one size larger, balanced as
  declared. The device budget still applies, so *quality* on a 4 GB
  machine gets the largest model that fits, not a larger one. A run that
  is already going keeps its model; a retry that climbs a tier climbs
  from the mode's tier. The cloud chat provider keeps its own routing
  (see [Cost](/ai/cost/)); the mode also sets how much of your notes is
  sent as context.

  | Agent tier | Economy | Balanced | Quality |
  |---|---|---|---|
  | tiny | tiny | tiny | small |
  | small | tiny | small | medium |
  | medium | small | medium | large |
  | large | medium | large | large |

  The mode moves the *automatic* choice. A model you picked yourself
  wins: an in-browser model chosen in the panel runs whenever it is at
  least the tier asked for (pick *Recommended for this device* to let the
  mode choose), and a configured Ollama model runs when it fits the
  tier.

  Ollama tiers are by parameter count (tiny ≤ 2.5 B, small ≤ 9 B,
  medium ≤ 16 B, larger is large) among the models you have installed;
  web-llm tiers are the catalogue's.
- **Download an Ollama model** — type a name (`qwen3:4b`,
  `hf.co/<owner>/<repo>`) and *Download*: the panel streams Ollama's
  `/api/pull` and shows the progress over all layers in bytes and
  percent, with *Cancel*. An edited address is saved first. A model under
  its own licence (Llama, Gemma, non-commercial ones) is named and
  confirmed before the download. When it finishes the installed list refreshes.
  The download goes to the Ollama server at the address above; no note
  content is involved.
- **Storage** — how much this site uses of the browser's quota
  (`navigator.storage.estimate()`), and two buttons: *Clear in-browser
  models* removes web-llm's caches (`webllm/model`, `webllm/wasm`,
  `webllm/config`, in Cache Storage or IndexedDB) after unloading the
  model, and *Clear speech and search models* removes transformers.js's
  cache (Whisper, embeddings). The app's own offline cache and your vault
  are not touched. The next use downloads the model again.
- **No WebGPU** — Firefox has no WebGPU on Linux and Android yet, and
  Android browsers vary. The panel says so by name: the in-browser chat
  model is off there, speech and search models run on WASM (slower,
  smaller models), and agents use Ollama (or the chat provider, if the
  policy allows it).

## Transcription and embeddings on this device

Speech recognition and text embeddings do not go through a chat model:
they run in a second worker on
[transformers.js](https://github.com/huggingface/transformers.js) with
ONNX Runtime (WebGPU when the GPU is usable, wasm otherwise). The ONNX
Runtime files are served from this app's own origin (`/ort/`), so no CDN
is contacted; the models come from Hugging Face and are cached in the
browser.

| Task | Model | Size | Notes |
|---|---|---|---|
| Voice memo (`🎙 Voice memo`) | `onnx-community/whisper-small` | ≈ 250 MB | WebGPU; multilingual (Hebrew included) |
| Voice memo on a strong GPU | `onnx-community/whisper-large-v3-turbo` | ≈ 800 MB | WebGPU, ≥ 6 GB budget |
| Voice memo without WebGPU | `onnx-community/whisper-tiny` | ≈ 40 MB | wasm, slower |
| Smart search embeddings | `Xenova/multilingual-e5-small` | ≈ 120 MB | 384 dimensions, ~100 languages |

Under *local only* the cloud Whisper API is never used; under *local
first* it is the fallback when the local path fails; under *cloud* it is
used directly.

## Ollama from the hosted app

A page served from `https://lumen-md.vercel.app` may only call your
local Ollama when Ollama allows that origin:

```
OLLAMA_ORIGINS=https://lumen-md.vercel.app ollama serve
```

(on macOS: `launchctl setenv OLLAMA_ORIGINS https://lumen-md.vercel.app`
and restart Ollama). Without it Ollama answers `403` and the improvement
agent suggests exactly this fix. The desktop app and `localhost`
development builds need no change.

## Research, grammar and search on this machine

`docker/local-ai.yml` starts three services:

| Service | Port | What it does |
|---|---|---|
| SearXNG | 8888 | Metasearch, no API key |
| research service | 8787 | The same worker Lumen deploys (`edge-workers/research`), run with `wrangler dev`: page extraction plus SearXNG search |
| LanguageTool | 8010 | Grammar and spelling checks |

```
docker compose -f docker/local-ai.yml up -d
```

Then `⌘K → Research: Settings → SearXNG on this machine` and enter
`http://localhost:8787`. Research questions are planned and answered by
your local model; quotes are still verified word for word against the
pages. Under *local only* a research service off this machine or network
is refused. On a fresh install with the *local only* policy, SearXNG is
the default research provider.

## Evaluating a local model

`npm run eval:agents` runs twelve fixed cases — most of them in Hebrew —
through the real agent runtime against your Ollama, and writes a report
to `eval/results/`:

```bash
ollama pull qwen2.5:7b
npm run eval:agents -- --model qwen2.5:7b
npm run eval:agents -- --model llama3.1:8b --only tagger-he,tasker-he
```

In CI the same cases run against a **fake Ollama server**
(`npm run fake-ollama`, `scripts/fake-ollama.mjs`) over real HTTP: the
runtime, the Ollama executor, the parsers and validators are exercised on
every pull request without a GPU. Only model quality needs the live run.

Every check is deterministic (Hebrew share of the letters, required and
forbidden words, list lengths, length limits, a pattern), so two models
or two prompt versions can be compared on the same numbers. The report
lists each case with pass/fail, attempts (retries the improvement agent
asked for) and time. The reference answers in
`src/agents/eval/fixtures.ts` run in CI through each agent's own parser
and validators, so a broken fixture is caught before a long GPU run.
