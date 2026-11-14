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
