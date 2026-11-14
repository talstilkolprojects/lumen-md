---
title: Quickstart
description: Get to your first beautiful Lumen document in 60 seconds.
---

## 1. Open Lumen

Either visit [lumen.app](https://lumen.app) (the hosted PWA), install the
desktop app (see [Install Lumen](/getting-started/install/)), or run
locally:

```bash
git clone https://github.com/talstilkol/lumen-md
cd lumen-md
npm ci
npm run dev
```

## 2. Type your first note

Hit `⌘N` for a fresh document. Try the smart paste — `⌘⇧V` opens an
"Insert anything…" dialog. Drop in:

- a YouTube link → it wraps as `\`\`\`embed`
- a CSV row → it wraps as `\`\`\`csv` and shows a sortable table + chart
  suggestions
- a SQL `CREATE TABLE` → ditto, parsed as data
- Mermaid `flowchart LR …` → renders as SVG
- A LaTeX equation → math typeset by KaTeX

## 3. Save it

`⌘S` saves to your local OPFS workspace. Open the workspace pane
(`⌘K → Toggle workspace`) to browse / rename / move files. Everything is
just markdown — your notes remain portable.

## 4. Power-user keys

| Key | Action |
| --- | --- |
| `⌘K` | Command palette (everything is here) |
| `⇧⌘F` | Focus mode |
| `⌘⇧V` | Smart Insert (auto-detect) |
| `⌘1`–`⌘4` | Source / Split / Preview / WYSIWYG |
| `⌘H` | Find and replace |
| `⌘O` / `⌘N` | Open / New |

Workspace search is `⌘K → Search workspace…`; the full list is on
[Keyboard shortcuts](/getting-started/shortcuts/).

Now start writing — and explore the [Editor modes](/editor/modes/) for the
heavier surfaces.
