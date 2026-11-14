---
title: Web Clipper
description: Save a web page as a clean Markdown note, from inside Lumen or with the browser extension, which hands the clip to the app. No clip server.
---

## Clip from inside Lumen

Two commands save a page into your vault as a clean note, with its source
and the date in the front matter:

- `⌘K → Clip a web page…` — paste a URL; Lumen fetches the page and keeps
  the article (`<article>` / `<main>`), without navigation, ads, forms and
  scripts. Fetching an arbitrary site needs the research service
  ([Research](/ai/research/)); without it, only sites the app's security
  policy already allows can be clipped, and Lumen says so.
- `⌘K → Clip from clipboard` — copy something on a page first; the copied
  HTML (or text) becomes the note.

Clips go into the **Library** folder (**ספרייה** with the interface in
Hebrew), get a number when the name is taken, and open in a new tab.

```yaml
---
title: "How CRDTs Work"
source: "https://martin.kleppmann.com/2020/07/06/crdt-hard-parts.html"
clipped: 2026-04-26
---
```

## The browser extension

The Lumen Web Clipper is a Chrome / Edge extension (Manifest V3). It sends
the page to Lumen, and **Lumen** turns it into a note. The extraction
happens in the app, so a clip comes out the same whichever way it arrives.

### Install (developer mode)

1. `chrome://extensions/` → turn on **Developer mode**
2. **Load unpacked** → pick the `extension/` folder of the repository
3. Open the extension's **Settings**: set the address of your Lumen (default
   `http://localhost:5173`), or choose **The Lumen desktop app**.

### Use

- **Save full page**: the toolbar button, or right-click → **Clip to Lumen**.
- **Save selection only**: select text first. Only the selection becomes the note.
- **Highlighter**: toolbar → **Highlighter on/off**, then select passages on
  the page. They are kept per address, marked again when you come back,
  and put at the top of the note (as `==highlight==` quotes) on the next clip.

### How a clip reaches Lumen

| Where Lumen runs | How |
|---|---|
| Browser tab | The extension finds (or opens) the Lumen tab and hands the clip to the page with `postMessage`. The app takes messages only from its own window and origin. |
| Desktop app | A `lumen://clip?…` link. If Lumen is already open, the running window gets it. |

Nothing is uploaded anywhere: there is no clip server.

## What a clip contains

The readable part of the page, found by [Defuddle](https://github.com/kepano/defuddle)
(MIT), with Mozilla Readability (Apache-2.0) as a fallback, and converted to
Markdown by Turndown (MIT):

```yaml
---
title: "The Counterpane"
source: "https://example.com/story"
author: "Ada Pierce"
published: "2026-10-01"
clipped: "2026-10-24"
tags: [clip]
---
```

Links and images point at the original page. Clips go into the library
folder (`Library/`, or `ספרייה/` when Lumen is in Hebrew).

### Templates by site

| Site | Folder | Extra |
|---|---|---|
| Wikipedia (any language) | `Library/Wikipedia` | `license: CC BY-SA 4.0`, `summary` |
| ynet | `Library/ynet` | `summary`, `topics`, `tags: [clip, news]` |
| Haaretz | `Library/Haaretz` | `summary`, `topics`, `tags: [clip, news]` |
| YouTube | `Library/YouTube` | `channel`, `published`, `summary`; the transcript when its panel is open |
| arXiv | `Library/arXiv` | `authors`, `arxiv`, `published`, `pdf`, `contribution`; the abstract |
| GitHub repositories | `Library/GitHub` | `description`, `purpose` |
| Pages marked as a schema.org `Recipe` | `Library/Recipes` | `tags: [clip, recipe]` |

A template is picked by its triggers: an address prefix, a `/regular expression/`
or `schema:@Type`. The first match wins.

Besides `{{title}}`, `{{url}}`, `{{content}}` and the rest, a template can read
the page with `{{meta:name}}` (a `<meta>` tag, by name, property or itemprop;
several tags of one name are joined) and `{{selector:css}}` (the text of the
elements a CSS selector picks).

## Interpreter: fields a local model fills in

A template can ask questions about the page: `{{"a one-sentence summary"}}`,
`{{"three key topics"|lower}}`. When a clip uses such a template, Lumen asks a
**model on your own device** — Ollama on this computer or your local network,
or the in-browser model if it is already loaded — and writes the answers into
the note. There is no cloud route: under any AI policy, the interpreter never
sends a page to an AI provider. With no local model running, those fields are
left out and the clip is saved as usual.

- The model reads only what the template points at (its `context` selectors:
  the abstract on arXiv, the lead section on Wikipedia, the transcript on
  YouTube), cut to about 6 000 characters, so a small model's window is
  enough. No `OLLAMA_ORIGINS` or context-size setting is needed in the
  desktop app.
- All questions of a template go in one request.
- The page text passes the prompt-injection guard before the model sees it,
  marked as outside data, and every answer is checked again before it is
  written into the note.

## Safety

A clip is outside content. Its `source:` marks the note as untrusted for the
AI agents (plan 2.7). Before the
note is saved, hidden text (zero-width characters, invisible tag characters,
hidden HTML) and instruction-like passages ("ignore previous instructions…")
are removed or visibly marked, with a warning at the top of the note.

## Accuracy

On the clipper golden set (plan 7.10: 20 pages with ads, cookie banners,
share bars, comments and footers around a public-domain article), the clip
must have the exact title, every paragraph in order and no noise on at least
90 % of pages. This is checked on every change (`clipperGolden.test.ts`).

## Privacy

The in-app commands fetch only the page you ask for (through the research
service when one is set up). The extension sends nothing over the network:
it reads the page you clip and hands it to your Lumen tab (`postMessage`) or
to the desktop app (a `lumen://clip` link). Its only request is opening your
Lumen address when no Lumen tab is open. No tracking and no telemetry. Its
manifest is
[`extension/manifest.json`](https://github.com/talstilkol/lumen-md/blob/main/extension/manifest.json).
