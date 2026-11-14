#!/usr/bin/env node
/**
 * Bundle the app's Bases engine (src/views/bases/api.ts, plan W6.46) into
 * dist/bases-engine.js for the MCP server and the CLI (plan W8.1), so
 * `bases_query` returns exactly the rows the app computes.
 *
 * Uses the esbuild of the repository root (a Vite dependency): run
 * `npm ci` in the root first. Without it the server still builds and runs;
 * its Bases tools then say they are not in this build.
 *
 *   node scripts/bundle-bases.mjs [--out dist/bases-engine.js]
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const i = process.argv.indexOf("--out");
const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(here, "../dist/bases-engine.js"));
let esbuild;
try {
  esbuild = createRequire(path.join(root, "package.json"))("esbuild");
} catch {
  console.warn("bundle-bases: esbuild not found (run `npm ci` in the repository root); dist/bases-engine.js not built, Bases tools will be unavailable.");
  process.exit(0);
}
await esbuild.build({
  entryPoints: [path.join(root, "src/views/bases/api.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: out,
  legalComments: "eof",
  // yaml is CommonJS and requires node built-ins: give the ESM bundle a require.
  banner: { js: 'import { createRequire as __lumenCreateRequire } from "node:module"; const require = __lumenCreateRequire(import.meta.url);' },
  // Packages (yaml) resolve from the root node_modules; NODE_PATH adds others (offline checks).
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [],
  logLevel: "warning",
});
console.log(`bundle-bases: ${path.relative(process.cwd(), out)}`);
