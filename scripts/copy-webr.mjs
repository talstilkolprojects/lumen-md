// OPT-IN (`npm run webr:local`): copies the webR runtime (R compiled to
// WebAssembly) from node_modules into public/webr/, so this deployment
// serves live R itself. Not part of predev/prebuild (plan W1.34): webR's
// binaries (R, libgfortran) are GPL-3.0, so Lumen's own build does not
// ship them, and each user downloads webR from the R block instead
// (src/plugins/r/webrInstall.ts, with the licence shown first). Run this
// only for a deployment whose operator accepts distributing webR under
// GPL-3.0 (its LICENSE.md). public/webr/ is git-ignored.
import { cpSync, existsSync, mkdirSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { stripSourceMapComments } from "./lib/stripSourceMaps.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// The package exports map hides package.json; resolve the main entry
// (dist/webr.cjs) and use its folder.
const srcDir = dirname(require.resolve("webr"));
const outDir = join(here, "..", "public", "webr");

// What is served and how (src/plugins/r/webrRuntime.json, shared with the
// in-app download): webr.js is webR's browser ES module (the package's
// "browser" export; its webr.mjs is the Node build), which the page imports
// from here; the rest are the files its worker fetches from its baseUrl;
// `vfs/` is the base R library (stats, graphics, utils…).
const RUNTIME = JSON.parse(readFileSync(join(here, "..", "src", "plugins", "r", "webrRuntime.json"), "utf8"));
const ENTRIES = RUNTIME.entries;

function size(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((a, f) => a + size(join(p, f)), 0);
}

mkdirSync(outDir, { recursive: true });
let bytes = 0;
let copied = 0;
for (const e of ENTRIES) {
  const src = join(srcDir, e);
  if (!existsSync(src)) continue;
  cpSync(src, join(outDir, e), { recursive: true });
  bytes += size(src);
  copied++;
}
// Both preludes (webrRuntime.json): the Trusted Types default policy for hosts that still
// send the page's `require-trusted-types-for 'script'` to the worker (its
// importScripts() of R.js would be blocked), then the worker's isolation —
// R can evaluate JavaScript there (webr::eval_js), so storage, messaging,
// nested workers and any network beyond this folder are removed first.
const WORKER_TT_PRELUDE = RUNTIME.trustedTypes;
const WORKER_ISOLATION_PRELUDE = RUNTIME.isolation;
const workerFile = join(outDir, "webr-worker.js");
if (existsSync(workerFile)) {
  const body = readFileSync(workerFile, "utf8");
  if (!body.startsWith("/* Lumen:")) writeFileSync(workerFile, WORKER_TT_PRELUDE + WORKER_ISOLATION_PRELUDE + body);
}

// Plan 11.5: no sourceMappingURL comments in what ships (the .map files are not copied).
stripSourceMapComments(outDir);
console.log(`copy-webr: ${copied} entries → public/webr/ (${(bytes / 1e6).toFixed(1)} MB)`);
