---
title: Web Clipper
description: Clip a page, a selection or your highlights into the vault as Markdown, with its source and date. No server involved.
---

The Lumen Web Clipper is a Chrome / Edge extension (Manifest V3). It sends
the page to Lumen, and **Lumen** turns it into a note. The extraction
happens in the app, so a clip comes out the same whichever way it arrives.

## Install (developer mode)

1. `chrome://extensions/` → turn on **Developer mode**
2. **Load unpacked** → pick the `extension/` folder of the repository
3. Open the extension's **Settings**: set the address of your Lumen (default
   `http://localhost:5173`), or choose **The Lumen desktop app**.

## Use

- **Save full page**: the toolbar button, or right-click → **Clip to Lumen**.
- **Save selection only**: select text first. Only the selection becomes the note.
- **Highlighter**: toolbar → **Highlighter on/off**, then select passages on
  the page. They are kept per address, marked again when you come back,
  and put at the top of the note (as `==highlight==` quotes) on the next clip.

## How a clip reaches Lumen

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
| Wikipedia (any language) | `Library/Wikipedia` | `license: CC BY-SA 4.0` |
| ynet | `Library/ynet` | `tags: [clip, news]` |
| Haaretz | `Library/Haaretz` | `tags: [clip, news]` |
| Pages marked as a schema.org `Recipe` | `Library/Recipes` | `tags: [clip, recipe]` |

A template is picked by its triggers: an address prefix, a `/regular expression/`
or `schema:@Type`. The first match wins.

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
