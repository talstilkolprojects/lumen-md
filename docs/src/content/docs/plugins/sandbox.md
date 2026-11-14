---
title: Plugin sandbox and permissions
description: How Lumen runs plugins with no access by default — QuickJS for logic, UI as data, a capability list the user grants.
---

Lumen runs every plugin with **no access by default**. A plugin gets only
the capabilities you grant it when you install it, and you can revoke them
at any time.

## Where plugin code runs

| Part | Runs in | What it can reach |
|---|---|---|
| Logic (`main`) | [QuickJS](https://github.com/justjake/quickjs-emscripten) (MIT), a separate JavaScript engine compiled to WebAssembly, inside its own Web Worker | Only the `lumen` object. There is no `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, DOM or storage, and no `import` of other modules. |
| Interface (panels, settings, block output) | Lumen itself | The plugin sends a **tree of known elements**: text, heading, paragraph, box, list, button, input, checkbox, select, code, link to a note, divider. There is no `img`, `iframe`, `form`, `style`, `script` or HTML, and no link to a web address. |

The interface is data rather than a sandboxed iframe on purpose. CSP and the
iframe `sandbox` attribute block every channel but one: a frame may always
navigate *itself* (`location = "https://…?" + text`). A tree of known
elements has no such channel.

## Limits

Each plugin has a 32 MB heap and a 512 KB stack. It gets 250 ms of CPU each
time Lumen enters its code (an event, the reply to a call), and its console
is capped at 120 lines a minute. A plugin that goes over a limit, or throws
an error nobody catches, is stopped.

## Capabilities

| Capability | Gives |
|---|---|
| `document:read` / `document:write` | The open note's text and selection / changing it |
| `vault:read` / `vault:write` | Listing and reading notes / writing notes |
| `commands` | Commands in the palette |
| `panel` | A side panel |
| `renderer` | Rendering a code-block language |
| `settings` | A settings section |
| `storage` | Its own key–value storage |
| `clipboard:write` | Copying text |
| `notifications` | Toasts |
| `network:https://exact.origin` | Requests to **that origin only** — https (http only for localhost), no cookies, no redirects, at most 5 MB of response |

Every capability the manifest asks for comes with a reason, which is shown
to you before you grant it. A call without its capability fails inside the
plugin with `PluginDenied` and never reaches Lumen. Lumen checks the grant
a second time on the host side, because the worker is a boundary, not the
policy.

## Network and privacy

Every request a plugin makes appears in the **privacy ledger** under
"Plugin". Under the **local-only** AI policy, plugin requests are blocked
and logged as blocked, even when the plugin has a network grant.

## Manifest (`lumen-plugin.json`)

```json
{
  "schema": 1,
  "id": "org.example.word-stats",
  "name": "Word stats",
  "version": "1.0.0",
  "description": "Counts words in the open note",
  "author": "Example",
  "license": "MIT",
  "main": "main.js",
  "capabilities": [
    { "id": "document:read", "reason": "To count the words of the open note" },
    { "id": "commands", "reason": "Adds the “Word stats” command" }
  ]
}
```
