---
title: Plugin SDK
description: Build your own Lumen plugin in 60 seconds with create-lumen-plugin.
---

Lumen plugins are tiny ESM modules that register custom blocks, commands,
and sidebar panels. The host loads them via dynamic `import(url)` so
there's no build pipeline to learn — write a function, ship a JS file.

:::caution[Being rewritten]
Plugins move to an isolated runtime with a permission prompt per capability
(plan 11.2); this page is replaced when that lands. `create-lumen-plugin`
isn't on npm yet: run it from `packages/create-lumen-plugin` in the
repository.
:::

## 30-second start

```bash
npx create-lumen-plugin my-cool-plugin
cd my-cool-plugin
npm install
npm run dev
```

Open Lumen → `⌘K` → **Plugin gallery** → **Load unpacked** → pick
`dist/my-cool-plugin.js`.

## The API

Every plugin exports a default `activate(api)` function. The `api`
argument has these methods:

```ts
interface LumenPluginAPI {
  registerBlock(lang: string, component: ComponentType<{ source, meta }>): () => void;
  registerCommand(cmd: { id, label, hint?, icon?, action }): () => void;
  toast(message: string, kind?: "info" | "success" | "warning" | "error"): void;
  getDocContent(): string;
  setDocContent(content: string): void;
  onDocChange(cb: (content: string) => void): () => void;
}
```

`activate` may return a cleanup function that runs when the user disables
or unloads the plugin — use it to call the unregister fns the API
returned, plus tear down any timers / DOM you created.

## Permissions model

`lumen-plugin.json` declares the permissions your plugin needs:

| Permission | Granted by default | What it lets you do |
| --- | :---: | --- |
| `register-block` | ✅ | Add a code-fence renderer |
| `register-command` | ✅ | Add palette entries |
| `register-panel` | ✅ | Add a right-sidebar panel |
| `read-doc` | ✅ | Read the active document |
| `write-doc` | ✅ | Mutate the active document |
| `workspace-read` | ❌ — prompts user | List + read every note |
| `workspace-write` | ❌ — prompts user | Create / overwrite notes |
| `network-fetch` | ❌ — prompts user | Make outbound HTTP requests |

## Publishing

1. `npm run build` produces `dist/<name>.js` — single ESM bundle, React
   left external (Lumen ships its own).
2. Push the dist to npm or any CDN (jsDelivr / unpkg).
3. PR against
   [`public/plugins/registry.json`](https://github.com/talstilkol/lumen-md/blob/main/public/plugins/registry.json) to
   list your plugin. Required fields: `id`, `name`, `description`,
   `version`, `icon`, `url`.

## Example: a custom CSV-with-emoji-header block

```tsx
// src/index.ts
import type { LumenPluginAPI } from "./types";
import { EmojiCsv } from "./block";

export default function activate(api: LumenPluginAPI) {
  return api.registerBlock("emoji-csv", EmojiCsv);
}

// src/block.tsx
export function EmojiCsv({ source }: { source: string }) {
  const [head, ...rows] = source.split("\n");
  const cols = head.split(",");
  return (
    <table>
      <thead>
        <tr>{cols.map((c) => <th key={c}>{c} 📊</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.split(",").map((c, j) => <td key={j}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
```

That's the whole plugin. ` ```emoji-csv ` blocks now render with the
emoji headers everywhere Lumen renders markdown.
