# __PLUGIN_TITLE__

A [Lumen](https://github.com/talstilkol/lumen-md) plugin. It runs in Lumen's sandbox (QuickJS): no network, no DOM, only the `lumen` API, and only the capabilities `lumen-plugin.json` asks for and the user grants.

## In five minutes

```bash
npm run dev        # serves this folder at http://127.0.0.1:5199 and watches it
```

1. In Lumen, open **Plugin gallery → Developer mode**, keep `http://127.0.0.1:5199` and press **Connect**. The plugin starts, with the capabilities it asks for.
2. Press `⌘K` and run **__PLUGIN_TITLE__**: the side panel shows the word count.
3. Edit `main.js` (try changing the text in `show()`) and save. Lumen reloads the plugin in under a second; the Developer panel shows the reload time.

No `npm install` is needed: the dev server and the test kit have no dependencies.

## Test

```bash
npm test
```

`tools/testkit.mjs` runs `main.js` against a mock of the `lumen` API with the sandbox's rules (a call without its capability rejects with `PluginDenied`). See `test/main.test.mjs`.

## The Developer panel

While your plugin runs, the Developer panel shows:

- which capabilities it used, and which granted ones it never used (ask only for what you use);
- its last calls to Lumen (method, time, refused or not);
- the CPU time spent in your code and the sandbox's memory.

## Publish

Bump `version` in `lumen-plugin.json` and open a pull request adding the folder under `public/plugins/examples/` (or your registry). Every version is scanned (`node scripts/scan-plugins.mjs`) before it is listed.
