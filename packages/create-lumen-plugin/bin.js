#!/usr/bin/env node
/**
 * create-lumen-plugin — scaffold a sandboxed Lumen plugin (plans 11.2, W3.10).
 *
 * Usage:
 *   npx create-lumen-plugin my-cool-plugin
 *
 * Creates `my-cool-plugin/` with:
 *   • lumen-plugin.json     — the manifest: id, version, the capabilities it asks for and why
 *   • main.js               — the plugin; runs in Lumen's QuickJS sandbox
 *   • test/main.test.mjs    — tests with the plugin test kit (`npm test`, Node's own runner)
 *   • tools/dev-server.mjs  — `npm run dev`: serves the folder to Lumen and hot-reloads on save
 *   • tools/testkit.mjs     — a mock of the `lumen` API with the sandbox's capability rules
 *   • README.md             — the five-minute walk-through
 * No dependencies: nothing to install.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const name = (args[0] ?? "").trim();

if (!name) {
  console.error("Usage: create-lumen-plugin <name>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]+$/.test(name)) {
  console.error("Plugin name must be lowercase-kebab-case (e.g. my-cool-plugin).");
  process.exit(1);
}

const dest = path.join(process.cwd(), name);

async function main() {
  if (await fs.stat(dest).then(() => true, () => false)) {
    console.error(`./${name} already exists.`);
    process.exit(1);
  }
  await fs.mkdir(dest, { recursive: true });
  const tplDir = path.join(__dirname, "template");
  await copyDir(tplDir, dest, name);
  console.log(`\n✨  Created Lumen plugin at ./${name}\n`);
  console.log(`Next steps (nothing to install):`);
  console.log(`  cd ${name}`);
  console.log(`  npm run dev          # serves the plugin at http://127.0.0.1:5199, reloads on save`);
  console.log(`  npm test             # the plugin test kit`);
  console.log(``);
  console.log(`In Lumen: Plugin gallery → Developer mode → Connect.`);
  console.log(``);
}

async function copyDir(srcDir, destDir, pluginName) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const srcPath = path.join(srcDir, e.name);
    const destPath = path.join(destDir, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath, pluginName);
    } else {
      let body = await fs.readFile(srcPath, "utf8");
      body = body.replace(/__PLUGIN_NAME__/g, pluginName);
      body = body.replace(
        /__PLUGIN_TITLE__/g,
        pluginName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      );
      await fs.writeFile(destPath, body, "utf8");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
