---
title: Model credits
description: Where Lumen credits the models it ships or downloads, ivrit.ai and Dicta first, with each licence's requirements.
---

`⌘K` → **Credits & model licences** opens the credits. Under **Model credits**, every model
and data file Lumen ships or can download (or ask Ollama to pull) has an
entry with:

- its name;
- its licence, linked;
- its source;
- the attribution its makers ask for;
- what the licence requires. For example, CC BY 4.0 needs a credit, a
  link to the licence and a note of changes, and the Llama licences need
  "Built with Llama".

The Hebrew models come first: ivrit.ai's speech models and Dicta's
DictaLM.

The list is built from `models/registry.json`, the same file the licence
gate checks. A test fails if a model that can reach users has no entry,
has an empty attribution, or has a licence whose requirements are not
known. Forbidden models are never listed, because the app cannot get
them.

## The licence gate

`npm run licenses` checks every entry of `models/registry.json` against the
app's code:

- A **forbidden** model must not be referenced anywhere in `src/`. The gate
  reads comments too, so a comment that only names one ("MMS and SASPEECH
  are non-commercial") counts as a reference. Put `licence-gate: mention-only`
  on that line to say it is only a mention. The marker covers its own line,
  and only the forbidden check. A real use on the next line, or the same
  name without the marker, still fails. Use it only in prose that explains
  why a model is not shipped.
- **CC BY-SA** entries are `conditional` and must say `unmodified: true` or
  `false`. Modified or derived content (changed weights, a shortened
  dictionary) reaches the user only as a download they start. An unmodified
  file may ship with the app, because the licence allows it. Its
  attribution, with the licence linked, then appears here in the credits
  and in the `notice` file next to it (for the Hebrew word list,
  `public/dict/NOTICE`).
