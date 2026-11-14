---
title: Developing a plugin
description: Scaffold a sandboxed plugin with create-lumen-plugin, run it with hot reload in developer mode, test it in Node with the test kit, and see what it does in the Developer panel.
---

## Five minutes from nothing to a running plugin

```bash
npx create-lumen-plugin my-plugin
cd my-plugin
npm run dev        # http://127.0.0.1:5199, watches the folder
```

1. In Lumen open **Plugin gallery**, then **Developer mode** at the bottom.
   Keep `http://127.0.0.1:5199` and press **Connect**.
2. Run the command your plugin registers from `⌘K` (in the template: *My plugin*): the side panel shows the word count of the note.
3. Change `main.js` and save. Lumen reloads the plugin by itself, usually
   in well under a second. The panel shows how long the last reload took.

Nothing needs installing: the dev server and the test kit use only Node
(20 or later).

## What is in the folder

| File | What it is |
|---|---|
| `lumen-plugin.json` | The manifest: id, name, version, and the capabilities the plugin asks for, each with the reason the user sees. |
| `main.js` | The plugin. It runs in the [sandbox](/plugins/sandbox/): only the `lumen` API, no DOM, no network unless asked for. |
| `test/main.test.mjs` | Tests, run with `npm test`. |
| `tools/dev-server.mjs` | The dev server behind `npm run dev`. |
| `tools/testkit.mjs` | The test kit. |

## Developer mode

Developer mode loads the plugin from the dev server instead of the
gallery:

- It connects only to this computer (`localhost`, `127.0.0.1`, `[::1]`).
- Keep the dev server on port 5199: the app's content security policy
  allows that port on this computer and no other.
- The plugin gets the capabilities its manifest asks for, without the
  permission screen: it is your own code.
- Each version is still run through the [safety scan](/plugins/permissions/),
  and the panel shows its notes. The scan's verdict does not block your own
  plugin here, but the gallery will not list a version that fails.
- On every save the dev server sends a `change` event and Lumen loads the
  manifest and `main.js` again. Changes that arrive during a reload are
  collected into one more reload.

## The Developer panel

While the plugin runs, the panel shows:

- **Reloads**: how many, how long the last one took (from the save to the
  plugin running again), and how long the start took.
- **CPU and memory**: the time spent in the plugin's code, how many runs,
  the longest, and the sandbox's memory.
- **Permissions: asked for and used**: each capability in the manifest,
  how often it was used and refused. A capability that is never used is
  marked: ask only for what you use, because users see the list before
  they install.
- **Last calls**: the plugin's last calls to Lumen, with their time and
  whether they were refused.

## Testing in Node

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "../tools/testkit.mjs";

test("shows the count", async () => {
  const p = await loadPlugin({ dir: ".", document: { text: "שלום עולם" } });
  await p.run("show");                       // a command it registered
  assert.equal(p.panel.tree.type, "box");    // the panel it rendered
});

test("needs document:read", async () => {
  const p = await loadPlugin({ dir: ".", grants: ["commands", "panel"] });
  await assert.rejects(p.run("show"), { name: "PluginDenied" });
});
```

`loadPlugin` runs `main.js` in a fresh Node `vm` context with a mock of the
`lumen` API. It follows the sandbox's rules: the same method table (a test
in Lumen keeps the two equal), a call without its capability rejects with
`PluginDenied`, and arguments must be JSON. The mock state is `document`
(`text`, `fileName`, `selection`), `vault` (`{"folder/note.md": text}`),
`settings`, `storage` and `fetch` for granted network calls.

You get back what the plugin did: `commands`, `panel`, `rendered`,
`document`, `vault`, `storage`, `notifications`, `clipboard`, `logs`,
`calls` and `denied`. You drive it with `run(id, payload)`,
`emit(name, payload)` (for example `"ui:panel"`), `render(lang, source)`
for a code-block renderer, and `select(from, to)`.

Node is not QuickJS, so test in Lumen too before you publish. Two
differences to keep in mind: QuickJS has no `Intl`, and the sandbox
limits CPU time and memory.

## Examples

The gallery's eight examples are in `public/plugins/examples/`:

| Example | Shows |
|---|---|
| Word stats | A panel, settings, Hebrew and English counting |
| Callout cards | A code-block renderer, storage |
| Quote of the day | Network access to one origin |
| Table of contents | Reading and writing the note |
| Hebrew date | A renderer and a command, a calendar computed without `Intl` |
| Tasks overview | Reading the whole vault (`vault:read`), a panel with note links |
| Bidi cleaner | Selection or whole note, notifications |
| Text format | A port of an Obsidian plugin (MIT), several commands |

## Publishing

Bump `version` in `lumen-plugin.json` and open a pull request that adds
the folder under `public/plugins/examples/` and a line in its
`index.json`. Run `node scripts/scan-plugins.mjs` first: every version is
scanned, and a version that fails is not listed.
