# Lumen Web Clipper (v2)

A Chrome / Edge extension (MV3) that sends the current page, your selection
and your highlights to Lumen, where it becomes a Markdown note with source
and date. The extraction (Defuddle, with Readability as a fallback, then
Turndown) runs in Lumen, not here. See `docs/src/content/docs/plugins/web-clipper.md`.

- `contentScript.js`: collects the page HTML, the selection and highlights; the highlighter.
- `bridge.js`: injected on the Lumen tab only; hands the clip to the app with `postMessage`.
- `background.js`: finds or opens the Lumen tab, or opens `lumen://clip?data=…` for the desktop app.

Install: `chrome://extensions/` → Developer mode → Load unpacked → this folder.

Templates, triggers and the highlighter follow the Obsidian Web Clipper
(MIT, © 2024 Obsidian). The code is ours and no Obsidian name or mark is used.
