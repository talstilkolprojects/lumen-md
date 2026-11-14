---
title: AI doctor
description: One check of the whole local-AI stack, from Ollama to the on-device engines, with the exact fix for each row.
---

Open it with `⌘K → AI: Doctor (diagnose local AI)`. Each row shows what the doctor found, and
every row that is not OK also gives the fix: a command to copy, a button
that applies the fix, or a link. The checks only read state. None of them
downloads a model or sends your notes anywhere.

## What it checks

| Row | OK when | Fix when it is not |
|---|---|---|
| AI policy and preferred executor | always (context) | — |
| Ollama server reachable | `/api/version` answers | install / `ollama serve`; `OLLAMA_ORIGINS` on a 403; rebuild with the address allowed when the CSP blocks it |
| Chat, configured, tool-calling and embedding models | installed | `ollama pull …` (button: *Download now*) |
| WebGPU, WebAssembly | available | use Ollama, or a browser with WebGPU |
| Vault storage | room left, durable | *Keep my data* |
| Service worker | registered | — |
| **CSP for the local services** | the page may connect to ports 8010 and 8787 | rebuild with `VITE_CSP_CONNECT_EXTRA` |
| Grammar (LanguageTool), research | they answer | `docker compose -f docker/local-ai.yml up -d`; *Use the local services* points both at that compose file |
| **Converted-model host** (Opus-MT, Nakdimon) | a host is set and the registry lists its files | waits for the owner's host choice (plan 15.9), then the conversion workflow |
| **Local translation** | Chrome's translator or Opus-MT can take English↔Hebrew | M2M100 downloads on first use with consent, or use Chrome |
| **English spelling** | the shipped dictionary flags a known misspelling | reload |
| **Hebrew spelling dictionary** | Hspell is installed | *Download (5.7 MB)* |
| **Niqqud** | Nakdimon is hosted | same as the converted-model host |
| **Image descriptions** | always available (download with consent on first use) | — |
| An executor the agents can use | one is available | `ollama serve` or the AI settings |

*Run one golden case per agent* runs a real model call for each agent
that has a golden case. Agents without one are listed as *skipped*, so you
can see which ones are missing.

## Local services

`docker/local-ai.yml` starts LanguageTool on port 8010 and the research
service on port 8787. The production CSP already allows both
(`http://localhost:8010`, `http://localhost:8787`), and the doctor checks
that the build you are running still allows them.
