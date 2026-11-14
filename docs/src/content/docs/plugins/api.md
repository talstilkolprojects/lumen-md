---
title: Plugin API
description: The lumen object a sandboxed plugin gets — every method, the capability it needs, its limits, and the UI elements.
---

A plugin's `main` is an ES module that runs in the sandbox (see
[Sandbox and permissions](/plugins/sandbox/)). It talks to Lumen only
through the global `lumen` object. Every method returns a promise. A
method whose capability you were not granted rejects with a `PluginDenied`
error.

## Events

```js
const off = lumen.on(name, (payload) => { … }); // off() unsubscribes
```

| Event | When | Payload |
|---|---|---|
| `command:<id>` | One of your commands ran | `{ source: "palette" }` |
| `render:<lang>` | A ```` ```<lang> ```` block needs rendering | `{ requestId, source }` |
| `ui:panel` / `ui:block` | A button was clicked or a field changed in your panel / block | `{ id, kind: "click" \| "change", value? }` |
| `panel:closed` | The user closed your panel | — |

Your handlers get 250 ms of CPU each time they are called. Waiting for a
`lumen.*` call does not count toward that.

## Methods

| Method | Capability | Notes |
|---|---|---|
| `document.getText()` / `getFileName()` / `getSelection()` | `document:read` | `getSelection()` → `{ from, to, text }` or `null` |
| `document.setText(text)` / `insertText(text)` / `replaceSelection(text)` | `document:write` | Insert replaces the selection at the cursor |
| `vault.list(dir?)` / `vault.read(path)` | `vault:read` | Relative paths only: no `..` and no hidden folders. Reads are capped at 5 MB |
| `vault.write(path, text)` | `vault:write` | `.md`, `.txt`, `.json` or `.csv` only, 5 MB at most |
| `commands.register({ id, label, hint? }, handler?)` / `commands.unregister(id)` | `commands` | Up to 50 per plugin. The label shows "· your plugin name" |
| `panel.open({ title? })` / `panel.render(tree)` / `panel.close()` | `panel` | One plugin panel at a time |
| `renderer.register(lang)` / `renderer.result(requestId, tree)` | `renderer` | Up to 10 languages. Languages Lumen renders itself (`mermaid`, `chart`, `csv`, …) are refused |
| `settings.get()` / `settings.set(object)` | `settings` | Your own JSON, 64 KB at most |
| `storage.get(key)` / `set(key, value)` / `delete(key)` | `storage` | Your own key–value store: 1,000 keys of at most 1 MB each. Removed when you are uninstalled |
| `clipboard.writeText(text)` | `clipboard:write` | — |
| `notifications.show(text, "info" \| "success" \| "error")` | `notifications` | Shown with your name in front |
| `network.fetch(url, { method?, headers?, body? })` | `network:<origin>` | Only to the exact origin you were granted. No cookies, no redirects, 30 s timeout, 5 MB at most. Returns `{ status, headers, body }`. Recorded in the privacy ledger; blocked under local-only |
| `lumen.manifest` | — | Your manifest (read-only) |

`console.log` / `warn` / `error` are allowed, up to 120 lines a minute.

## UI elements

Panels and rendered blocks are **trees of these elements**, and nothing
else:

`text {text}` · `heading {level 1–3, text}` · `paragraph {children}` ·
`box {direction "row"|"column", gap, children}` · `list {ordered, items: [[…]]}` ·
`button {id, label, primary?, disabled?}` · `input {id, value?, placeholder?, multiline?}` ·
`checkbox {id, label, checked?}` · `select {id, value?, options: [{value, label}]}` ·
`code {text, lang?}` · `noteLink {target, label?}` (a note in the vault, never a URL) · `divider`

A tree can have at most 2,000 nodes, nest at most 24 levels deep, and hold
at most 20,000 characters of text per node. An unknown element or field is
refused.

## Examples

The examples live in `public/plugins/examples/`:

- `word-stats` — a command, a panel, settings, `document:read`
- `callout` — a code-block renderer that keeps checklist ticks in `storage`
