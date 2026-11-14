---
title: Research and citation checks
description: Ask a question and get a note with a quoted source for every claim; check the citations in any note.
---

## Research: Ask a Question

Command: `🔎 Research: Ask a Question…`.

Lumen searches the web, reads the sources and writes a new note. The
note starts with a short summary, followed by sections, and every claim
carries a footnote. Each footnote holds the passage from the source
that supports the claim:

```md
Roses are pruned in early spring.[^1]

[^1]: [Rose guide](https://example.org/roses) — “Prune roses in early spring, when buds swell.”
```

Choose how Lumen searches with `🔎 Research: Settings…`:

| Search | Needs | How it works |
|---|---|---|
| **Claude web search** (default) | AI provider set to Claude (Anthropic) | One request: Claude searches (up to 5 searches), reads and answers. The quotes are copied word for word from the pages by Anthropic. Anthropic bills the searches separately from tokens. |
| **Brave Search** / **Tavily** | Your own API key, and the research service on this deployment | Lumen plans 2–4 searches and reads up to 6 pages. It sends the model only the parts relevant to your question, then **checks every quote against the page it came from**. A quote that can't be found is marked ⚠️ in the note. |

Pages the research read but didn't cite are listed under "Also read".
Every model call appears in `AI: Usage & Cost This Month`. A research
run counts as one prompt against your plan's AI quota.

## Research: Verify Citations in This Note

Command: `🔎 Research: Verify Citations in This Note`.

This works on any note, not only research output. Lumen reads the
footnotes that link to web pages and checks each one:

| Result | Meaning |
|---|---|
| ✅ quote found | The quoted passage is on the page. Quote marks, dashes, case and spacing don't need to match exactly. |
| 🟡 found approximately | At least 85% of the quote's words appear close together on the page. A quote longer than 200 words is scored on samples, so it is "approximate" unless it is on the page word for word. |
| ❌ quote not found | The page is reachable, but the passage isn't on it. |
| 💀 dead link | The page returned an HTTP error. |
| ⚠️ couldn't read | The address was blocked, the page isn't HTML or text, or the request timed out. |
| 🔗 reachable | The footnote has no quote, so only the link was checked. |

Footnotes can be written as `[^1]: [Title](url) — “quote”`, as
`[^1]: url "quote"`, or as just a link.

## The research service

Reading pages and Brave / Tavily searches go through a small worker that
your deployment runs (`edge-workers/research`, set with
`VITE_RESEARCH_ENDPOINT`). Browsers can't fetch other sites directly.

- It only reads public http(s) pages, never internal addresses.
- It reads at most 2 MB per page.
- It forwards no cookies.
- Your search key is passed through for each request and is never
  stored.
- It only answers your app's own origins.
- It requires a shared token (`RESEARCH_TOKEN`). Your deployment builds
  it into the app (`VITE_RESEARCH_TOKEN`), or you enter it under AI
  settings → Research token. A token entered there is sent only to the
  research address that was in use when you saved it. Without a token
  configured, the service refuses every request.

Claude web search doesn't need the service.

## Known limitations — status

| Id | Limitation | Status |
|---|---|---|
| A7 | Approximate quote matching is a heuristic with a compute budget | Decision: kept. The check runs on your device, so a long quote is scored on up to 5 samples of 200 words. A quote is ✅ only when it is on the page word for word; a full score on the samples alone is 🟡 "checked on samples". |
| A8 | No real authentication without accounts | Fixed in part. The token is now required: a service without one refuses everything. In a public web app the token ships in the app, so it only stops casual reuse. To restrict who may use it, put the service behind Cloudflare Access and add a rate-limiting rule. |
