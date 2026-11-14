---
title: Cloud only by choice
description: Every AI feature has an engine on this device; a cloud service is used only when you choose it. The full list of cloud routes and what each needs.
---

Lumen's AI runs on this device by default. A cloud service is contacted
only after you choose it, and the **AI policy**
(`⌘K → "AI: Local or Cloud Policy"`) decides how far that choice goes:

| Policy | What may leave this device |
|---|---|
| **Local only** (the default on a fresh install) | Nothing. Every cloud route below is refused before a request is made; the network layer blocks it a second time and the privacy ledger lists the attempt. |
| **Local first** | Only a fallback to the AI provider whose key you entered, when no local engine can answer. Services you never set up — the public LanguageTool API, the browser's online speech recognition, server-side read-aloud voices — stay off. |
| **Cloud** | The selected provider directly, and the third-party services in the table. |

An installation that was set up with a cloud key before policies existed
starts in *local first* (with a cloud provider selected: *cloud*), so an
upgrade never silently changes where prompts go. Pick a policy once and
that choice wins.

## Every cloud route

Each route has an id; `src/__tests__/cloudRoutes.test.ts` fails when a
source file reaches a cloud service without being in this list, or when a
route loses its gate.

| Capability | Route id | On this device | Cloud option | Cloud used when |
|---|---|---|---|---|
| Chat, writing, agents | `chat-openai` | Ollama, then web-llm (WebGPU) | OpenAI | provider selected; *local first* fallback |
| Chat, writing, agents | `chat-anthropic` | Ollama, then web-llm (WebGPU) | Anthropic (Claude) | provider selected; *local first* fallback |
| Chat, writing, agents | `chat-gemini` | Ollama, then web-llm (WebGPU) | Google Gemini | provider selected; *local first* fallback |
| Chat, writing, agents | `chat-mistral` | Ollama, then web-llm (WebGPU) | Mistral | provider selected; *local first* fallback |
| Smart search embeddings | `embeddings-openai` | Ollama embedding model, else multilingual-e5-small (transformers.js) | OpenAI embeddings | *cloud* only |
| Batch jobs | `batch-api` | the local batch queue | OpenAI / Anthropic Batch API | *cloud* only |
| Fine-tuning | `fine-tune` | style profiles | OpenAI fine-tuning | outside *local only*, when you run it |
| Voice memo transcription | `whisper-1` | Whisper in the browser (transformers.js) | OpenAI `whisper-1` | *cloud*; *local first* when the local model fails |
| Grammar check | `languagetool` | a LanguageTool on this machine, else the local proofreader agent | the public LanguageTool API (or a remote LanguageTool you configured) | public API: *cloud* only; your own remote server: outside *local only* |
| Web research | `web-research` | your library, or a research service on this machine | Claude web search / a hosted research service | outside *local only*, after the one-time web consent |
| Dictation | `speech-recognition` | voice memo with local Whisper | the browser's speech recognition (Chrome sends the audio to Google) | *cloud* only |
| Read aloud | `network-voices` | the system's on-device voices | server-side browser voices ("Google …") | *cloud* only |
| PlantUML diagrams | `plantuml-kroki` | — (no local renderer yet) | kroki.io draws the diagram from its text | *cloud*; otherwise only for a diagram you choose to send ("Render this diagram with kroki.io") |
| Jewish sources | `sefaria-texts` | the copy you saved for offline (Sources/Sefaria) | Sefaria's texts API: the reference only, such as "Genesis 1:1" | under any policy, each time you confirm a lookup; a saved source needs no request |
| Publishing to Bluesky (Standard.site) | `atproto-publish` | nothing is published (Export Markdown and the static site stay local) | your own AT Protocol account (PDS): the open note as a public record, redacted first; plc.directory to find your PDS | under any policy, only when you run Publish, Update or Unpublish on one note and confirm that the record is public and permanent |
| Laws and Knesset records | `knesset-odata` | laws you saved for offline (Sources/Knesset/Laws); "Ask the law" searches only them | the Knesset's OData service: the law or bill name only, such as "הגנת הפרטיות" | only after you turn Knesset sources on, each time you confirm a lookup |

Model downloads (Hugging Face, the OCR and dictionary files) carry no
content of yours; they are listed in the privacy ledger and happen only
when a feature needs the model.

## Checking it yourself

- `⌘K → "Privacy ledger"` lists every AI request: host, size, policy and
  whether it was allowed or blocked.
- The end-to-end test `e2e/local-only-all-commands.spec.ts` runs every AI
  command under *local only* with cloud keys saved and a cloud provider
  selected, and expects zero requests to any cloud host.
