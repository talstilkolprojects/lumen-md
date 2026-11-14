---
title: Dynamic blocks reference
description: The fenced code-block languages that Lumen renders as live, interactive previews.
---

Lumen's killer feature is **dynamic blocks**: write a fenced code block in markdown, and the preview renders it as a chart, diagram, table, map, or live sandbox. Every block degrades gracefully — if rendering fails, you still see the source.

## Quick-reference table

| Fence | Renders as | Notes |
|---|---|---|
| ` ```mermaid ` | Inline SVG diagram (flowcharts, sequence, gantt, class, state, ER) | Mermaid v11; lazy-loaded |
| ` ```chart ` | ECharts (line / bar / pie / scatter / heatmap / radar / boxplot / treemap / sunburst / sankey) | YAML or JSON spec |
| ` ```csv ` / ` ```tsv ` | Sortable / filterable DataTable + auto-chart suggestion | Title via `title="..."` |
| ` ```json-table ` | DataTable from a JSON array | Array of objects required |
| ` ```sql ` / ` ```pandas ` / ` ```object ` / ` ```data ` | Tabular display via the shared `DataBlock` renderer | `pandas` parses DataFrame `to_dict()` shape |
| ` ```map ` / ` ```geojson ` | Leaflet map (tile, markers, polygons, popups) | GeoJSON or YAML map-spec |
| ` ```dot ` / ` ```graphviz ` | Graphviz diagram via WASM | Rendered locally — no Kroki dependency |
| ` ```plantuml ` / ` ```puml ` | PlantUML via kroki.io | Network egress; opt out via privacy mode |
| ` ```abc ` | ABC music notation (renderable score) | Abcjs |
| ` ```model ` | 3-D model viewer (`<model-viewer>`) | GLB / GLTF |
| ` ```embed ` | Universal embed (YouTube, Vimeo, Twitter, Loom, CodePen, oembed) | URL on the body line |
| ` ```html ` / ` ```html-preview ` | Sanitized HTML preview | DOMPurify allowlist; no JS executes in the page |
| ` ```svg ` / ` ```live-svg ` | Sanitized inline SVG preview | Same hardening as HTML |
| ` ```live-js ` | JS sandbox (Worker isolate) with console output | Stdout/stderr/error states; timeout-protected; `shared` = one REPL scope per document (see below) |
| ` ```live-lua ` / ` ```lua-live ` | Lua 5.4 (wasmoon WASM) in a Web Worker, with `print`/`io.write` output and return values | Loads on Run; self-hosted wasm (no CDN); `timeout=` ms (default 5000) |
| ` ```live-r ` / ` ```r-live ` | R (webR, WebAssembly): printed output, messages, warnings, errors and base-graphics plots | Loads on first Run (~45 MB, self-hosted, cached); `timeout=` ms (default 30000); base R + bundled recommended packages, no CRAN installs |
| ` ```live-ruby ` / ` ```ruby-live ` | Ruby 3.4 (ruby.wasm) in a sandboxed Web Worker: `puts`/`warn` output, the last value (`=> …`), errors with `block:<line>` | Loads on first Run (~30 MB, self-hosted, cached); `timeout=` ms (default 10000; a runaway loop is killed); full stdlib (`require "json"`, `set`, …), no gems; fresh VM per run; no network, storage or JS bridge |
| ` ```playground [react\|vue] ` / ` ```web-playground ` | A small multi-file web project run live: files separated by `--- name.ext ---` lines (HTML, CSS, JS, JSX, TS, JSON); Preview, a tab per file, and a Console | Runs in a sandboxed iframe on its own origin (no access to your documents); JSX / TypeScript via Sucrase; `react` / `react-dom` (18) and `vue` (3, with the template compiler) are provided offline — other packages aren't; entry is `main.*`; `height=` px |
| ` ```live-css ` | Sandboxed iframe HTML+CSS preview | `srcdoc` + sandbox flags |
| ` ```live-glsl ` / ` ```glsl ` / ` ```shader ` | GLSL fragment shader on a quad | Hot-reloads on edit |
| ` ```bibtex ` / ` ```bib ` | Citation list (formatted from BibTeX) | Click → copy citation |
| ` ```database ` | Workspace-wide database query (markdown frontmatter as the "table") | Lumen-native query DSL |
| ` ```insights ` / ` ```jsonl ` | JSONL analyzer: conclusions, freq, charts, file generators | No external model |
| ` ```code-doctor ` / ` ```fix-json ` | Malformed JSON/JSONL repair with diff + accept-fix UI | 7-pass tolerant tokenizer |

## Live JavaScript — shared scope (REPL across blocks)

By default every ` ```live-js ` block runs in its own fresh Web Worker, so nothing one block defines is visible to another. Add `shared` to the fence to turn the blocks of a document into one REPL session:

````markdown
```live-js shared
const prices = [12, 7, 30]
function total(xs) { return xs.reduce((a, b) => a + b, 0) }
```

Some prose in between…

```live-js shared
console.log(total(prices))   // 49
```
````

- All `shared` blocks of the open document use **one worker**, and its global scope persists across runs and across blocks. Top-level `const` / `let` / `var`, `function` and `class` declarations become globals of that worker, so later runs and later blocks can use them. Declarations nested in blocks, functions or loop heads stay local.
- As in a browser console, running a block again may redeclare its names, and top-level `const` bindings can be reassigned by later runs.
- Blocks share state in the order they **run**. Each block runs when it renders and when you click **Run**; runs are queued and execute one at a time.
- `shared=name` (for example ` ```live-js shared=physics `) gives a separate named scope inside the same document. Different documents never share a scope.
- **Reset scope** (shown on shared blocks) discards the worker and every global in it; the next run starts fresh. Re-run the blocks you depend on afterwards.
- Sandboxing is unchanged: the worker has no DOM and no access to the page, shared mode adds no module or network-import support (the page CSP still applies inside the worker), and a run that exceeds the 8-second timeout is stopped. A timeout terminates the worker, which also resets the scope.
- An unused scope is disposed five minutes after the last shared block of that document unmounts.

## Live Lua

````markdown
```live-lua height=200 timeout=3000
local function fib(n) return n < 2 and n or fib(n - 1) + fib(n - 2) end
for i = 1, 10 do io.write(fib(i), " ") end
print()
return _VERSION
```
````

Click **Run** to execute. Nothing is downloaded until then; the ~270 KB `glue.wasm` is bundled with Lumen and served from the same origin, so it works offline and under the app's CSP. Each run gets a fresh Web Worker and a fresh Lua state:

- `print` and `io.write` stream to the output panel; values `return`ed from the chunk are shown after a `→`.
- Errors show the line (`block:2: boom`).
- A runaway loop is stopped after `timeout` ms (100–60000, default 5000) by an instruction-count hook, and the page kills the worker if it stops responding. **Stop** cancels a run.
- The Lua heap is capped at 64 MB and captured output at 200 000 characters.
- The standard libraries are available except process and file access: `os.exit`, `os.execute`, `os.getenv`, `os.remove`, `os.rename`, `io.open`, `io.popen`, `io.read`, `require`, `dofile`, `loadfile` and `package` are removed. Lua cannot reach JavaScript objects.

## Security & hardening

All HTML, SVG, and embed renderers funnel through `src/lib/markupSanitizer.ts`. The sanitizer:

- Strips every `on*` attribute via a prefix-matching hook (not just the named list, so future handlers like `onpointerdown` are caught).
- Blocks `style` attributes containing `expression(...)`, `url(javascript:...)`, or `behavior:`.
- Allows only image-MIME `data:` URIs (everything else, including `data:text/html`, is dropped).
- Rejects `javascript:`, `vbscript:`, and unknown protocols.

Each dynamic block is wrapped in an `ErrorBoundary` so a single broken block doesn't take down the whole preview.

## Lazy loading

Every block is `React.lazy`-imported. A block's library (Mermaid, ECharts, Leaflet, …) loads only when a note that uses it is opened, so adding block types never grows the startup bundle. That bundle has a size budget, checked on every pull request (`scripts/bundle-budget.mjs`).

## Authoring a new block

See [Plugin SDK](/plugins/sdk/) — every block is a React component registered with `registerPlugin`. The `pluginSystem` wires its fence language to a tag, mounts via `Suspense`, and routes it through the renderer pipeline.

## Web Playground

````markdown
```playground react height=260
--- App.jsx ---
import { useState } from "react";
export default function App() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
}
--- main.jsx ---
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
createRoot(document.getElementById("root")).render(<App />);
--- style.css ---
button { font: 16px system-ui; }
```
````

- **Files:** `--- name.ext ---` starts a file. A body without markers is one file (`main.jsx` for React, `main.js` otherwise). `index.html` is the page body (default `<div id="root">`, or `<div id="app">` for Vue); its `<script>` tags don't run, so put code in files.
- **Imports:** relative imports between files (with or without the extension), CSS / JSON files, and the provided `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime` and `vue`.
- **Isolation:** each Run loads a fresh runner document in a sandboxed iframe with an opaque origin and its own Content-Security-Policy. The project can't read the app's storage, cookies or page.
