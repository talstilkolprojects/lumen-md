#!/usr/bin/env node
/**
 * Bundle-size budget enforcer.
 *
 * Runs after `npm run build` and walks `dist/assets/*.js`, comparing each
 * file (gzipped) against the per-chunk-class budgets below. Exits non-zero
 * when any budget is exceeded — so CI fails on a regression.
 *
 * The budgets reflect what Lumen ships *today* with a small headroom, so we
 * catch rgressions without rewriting the file every time we add a feature.
 * Update the table when an intentional new feature lands.
 *
 * `--json <file>` also writes the gzipped size per budget class (summed
 * over its files) and in total, for scripts/bundle-diff.mjs.
 */

import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import * as path from "node:path";

const DIST = path.join(process.cwd(), "dist", "assets");

// Each rule applies to files whose name matches `pattern`. Budget is in KB
// (gzipped). The first matching rule wins, so put narrower regexes first.
const BUDGETS = [
  // main is the eager Lumen runtime (App + side panels + i18n table).
  // History:
  //   Round-16: 222 → 225 (TDZ fix re-chunked katex; react+react-dom merged)
  //   Round-25: 225 → 230 (y-websocket externalize; macOS↔Linux gzip variance)
  //   Audit M12-followup-2: 230 → 195 (rehype-raw lazy-loaded; parse5 +
  //       entities + hast-util-raw moved into a dynamic chunk that only
  //       fires when a doc contains inline HTML). Measured: 177.9 KB
  //       gzipped on macOS post-fix. Budget gives ~17 KB headroom for
  //       Linux gzip variance + future first-party growth.
  // With Vite 8 the startup code shared by the HTML entries lives in
  // `app-*`; the entry `main-*` is a stub and gets a tight budget of its own,
  // so code moving back into it can't double the startup allowance.
  { name: "main bundle",        pattern: /^app-/,                 budgetKb: 195 },
  { name: "entry stub",         pattern: /^main-/,                budgetKb: 5 },
  { name: "entry index",        pattern: /^index-/,               budgetKb: 220 },
  // mermaid: 800 → 860 (2026-10 dependency audit). mermaid 11.15 → 11.17.2
  //   fixes GHSA-6x64-9x62-f2gx (CSS injection), GHSA-c4c3-pg64-4m4v and
  //   GHSA-3rrr-jr9j-h3q3 (prototype pollution), GHSA-2v8p-3f2j-5mp7 and
  //   GHSA-rhh3-jpg6-66xh (DoS). Measured 833.3 KB gzipped on Linux after
  //   the bump; lazy chunk, only fetched when a doc has a mermaid block.
  { name: "vendor: mermaid",    pattern: /^vendor-mermaid-/,      budgetKb: 860 },
  // shiki sits at ~263 KB gzipped today. The budget previously read
  // 1800 KB — a relic from when per-language grammars were bundled into
  // the same chunk. They've since been split into assets/shiki-langs/*
  // and are fetched on-demand via the SW cache, so the core shiki
  // wrapper is small and stable. 320 KB gives ~50 KB headroom without
  // hiding a meaningful regression.
  { name: "vendor: shiki",      pattern: /^vendor-shiki-/,        budgetKb: 320 },
  { name: "vendor: codemirror", pattern: /^vendor-codemirror-/,   budgetKb: 600 },
  { name: "vendor: echarts",    pattern: /^vendor-echarts-/,      budgetKb: 400 },
  { name: "vendor: graphviz",   pattern: /^vendor-graphviz-/,     budgetKb: 700 },
  { name: "vendor: yjs",        pattern: /^vendor-yjs-/,          budgetKb: 180 },
  { name: "vendor: milkdown",   pattern: /^vendor-milkdown-/,     budgetKb: 200 },
  // vendor-react now bundles both react and react-dom (round-16);
  // splitting them caused a circular-import init crash.
  { name: "vendor: react",      pattern: /^vendor-react-/,        budgetKb: 160 },
  { name: "vendor: katex",      pattern: /^vendor-katex-/,        budgetKb: 110 },
  { name: "vendor: leaflet",    pattern: /^vendor-leaflet-/,      budgetKb: 60 },
  { name: "vendor: git",        pattern: /^vendor-git-/,          budgetKb: 110 },
  // Excalidraw (the canvas, plan 4.19), lazy: the editor and its deps. Its
  // Mermaid → diagram dialog is a separate chunk (vendor-excalidraw-mermaid),
  // loaded on demand; fonts are static files under public/excalidraw/.
  { name: "vendor: excalidraw-mermaid", pattern: /^vendor-excalidraw-mermaid-/, budgetKb: 120 },
  // Excalidraw's own core module (dist/prod/chunk-*.js) is one file that no
  // chunk grouping can split: 718.6 KB gzipped on 0.18.1 (verify/train,
  // 11.11.2026), after the locales, subsetting and shared chunks moved out.
  // Decision 11.11 (Claude, under Tal's delegation of every decision): a rule
  // of its own at 740 KB — measured + 3% headroom, never a blanket raise.
  // Lazy (canvas only) and not precached. Plan task W1.36 looks for a smaller
  // build of it and lowers this rule when one lands.
  // The rule names that one module only: Excalidraw's chunk stem EIO257PC
  // (0.18.1; the W1.36 probe build lists it as a single 1,796 KB module).
  // Every other Excalidraw shared chunk stays at 700 (review 13.5). A new
  // Excalidraw build renames the stem, falls to 700 and fails: the rule is
  // then decided again, not inherited.
  { name: "vendor: excalidraw core", pattern: /^vendor-excalidraw-chunk-EIO257PC-/, budgetKb: 740 },
  { name: "vendor: excalidraw", pattern: /^vendor-excalidraw-/,   budgetKb: 700 },
  // @google/model-viewer + three.js, self-hosted (CSP bans the unpkg CDN).
  // Dynamic-imported only when a document contains a ```model3d block.
  { name: "vendor: modelviewer", pattern: /^vendor-modelviewer-/, budgetKb: 320 },
  { name: "vendor: other",      pattern: /^vendor-/,              budgetKb: 200 },
  // pdfjs-dist text extractor — lazy-loaded only when the user imports a PDF.
  // ~144 KB gzipped today; the heavy worker ships as a separate .mjs (not
  // size-checked here). It never touches the eager startup path.
  { name: "lazy: pdfjs",        pattern: /^pdf-/,                 budgetKb: 165 },
  // Prettier (Format document / code block) — standalone core + one chunk
  // per language plugin, all dynamic-imported on first format. The
  // TypeScript parser plugin is the largest: ~124 KB gz with Vite 6, 204 KB
  // with Vite 8 (Rolldown keeps the TypeScript diagnostics table that
  // esbuild dropped). Only loaded when formatting TS / JS.
  { name: "lazy: prettier",     pattern: /^prettier-/,            budgetKb: 215 },
  // abcjs (music notation), lazy-loaded by the abc block. Same size as
  // before; Vite 6 named the chunk `index-*` (it fell under "entry index").
  { name: "lazy: abcjs",        pattern: /^abcjs-/,               budgetKb: 160 },
  // The canvas dialog around Excalidraw (lazy).
  { name: "lazy: canvas",       pattern: /^CanvasExcalidraw-/,    budgetKb: 40 },
  // cytoscape (mermaid's graph layouts), lazy, split out of vendor-mermaid.
  { name: "lazy: cytoscape",    pattern: /^cytoscape/,            budgetKb: 150 },
  // TypeScript compiler + ES/DOM lib .d.ts files for the opt-in "TypeScript
  // checks in code blocks" (src/lsp). One worker file, fetched only after
  // the user enables the setting; excluded from the PWA precache. Measured
  // 1325 KB gzipped (TypeScript 5.9).
  { name: "lazy: ts checker",   pattern: /^tsCheck\.worker-/,     budgetKb: 1450 },
  // web-llm (WebGPU inference) runs in its own worker; the main thread only
  // ships a few KB of message passing. The library inlines the tokenizer
  // wasm and the TVM runtime: measured 2082 KB gzipped (0.2.82). Fetched
  // only on the first in-browser AI prompt, never precached.
  { name: "lazy: web-llm worker", pattern: /^webllm\.worker-/,    budgetKb: 2200 },
  // transformers.js (local Whisper + embeddings) runs in its own worker;
  // the ONNX Runtime wasm it loads is served from public/ort/, not bundled.
  { name: "lazy: transformers worker", pattern: /^transformers\.worker-/, budgetKb: 700 },
  // Graphviz (viz.js wasm) now runs in its own worker so the page CSP needs
  // no unsafe-eval: the old vendor-graphviz chunk moved here (~608 KB gz).
  { name: "lazy: graphviz worker", pattern: /^graphviz\.worker-/,  budgetKb: 700 },
  { name: "lazy plugin chunk",  pattern: /\.js$/,                 budgetKb: 100 },
];

function format(kb) {
  return kb.toFixed(1).padStart(7) + " KB";
}

async function main() {
  let entries;
  try {
    entries = await fs.readdir(DIST);
  } catch {
    console.error(`No dist/assets directory — run \`npm run build\` first.`);
    process.exit(2);
  }
  const jsFiles = entries.filter((f) => f.endsWith(".js"));
  // Plan 11.5: 0 source maps in the build — no .map files and no
  // sourceMappingURL comments anywhere in dist/ (LUMEN_SOURCEMAP=1 is for local use only).
  if (process.env.LUMEN_SOURCEMAP !== "1") {
    const { findSourceMaps } = await import("./lib/sourcemaps.mjs");
    const maps = await findSourceMaps(path.join(process.cwd(), "dist"));
    if (maps.length) {
      console.error(`✗ ${maps.length} source map(s) in dist/ (plan 11.5 allows none):\n  ${maps.slice(0, 10).join("\n  ")}`);
      process.exit(1);
    }
    console.log("  ✓ 0 source maps in dist/");
  }
  if (jsFiles.length === 0) {
    console.error("dist/assets has no .js files.");
    process.exit(2);
  }

  let failed = 0;
  /** Every failure, repeated in one block at the end of the output. */
  const failures = [];
  let total = 0;
  /** Gzipped KB per budget class, for --json. */
  const classes = {};
  console.log(
    "\n  Budget                  Actual          File\n" +
      "  ─────────               ─────────       ────",
  );

  for (const file of jsFiles.sort()) {
    const buf = await fs.readFile(path.join(DIST, file));
    const gzipped = gzipSync(buf).length;
    const kb = gzipped / 1024;
    total += kb;
    const rule = BUDGETS.find((r) => r.pattern.test(file));
    if (!rule) continue;
    const c = (classes[rule.name] ??= { kb: 0, files: 0 });
    c.kb += kb;
    c.files++;
    const ok = kb <= rule.budgetKb;
    if (!ok) {
      failed++;
      failures.push(`${rule.name}: ${file} ${kb.toFixed(1)} KB / ${rule.budgetKb} KB`);
      // An annotation, so the failing file shows on the PR without the job log.
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=bundle budget::${rule.name}: ${file} is ${kb.toFixed(1)} KB gzipped, budget ${rule.budgetKb} KB`);
    }
    const mark = ok ? "✓" : "✗";
    console.log(
      `  ${mark} ${rule.name.padEnd(20)} ${format(kb)} / ${format(rule.budgetKb)}   ${file}`,
    );
  }

  console.log(`\n  Total gzipped: ${format(total)}`);

  // Plan 4.19: tldraw left the bundle with the move to Excalidraw. No chunk
  // may carry it again (its licence beacon and CDN fonts are third-party
  // traffic), and nothing may point at its CDN.
  const TLDRAW_MARKS = [/vendor-tldraw-/i, /cdn\.tldraw\.com/, /tldraw\/tldraw\.css/, /@tldraw\//, /"tldraw"/];
  const tldrawHits = [];
  for (const file of jsFiles) {
    if (/^vendor-tldraw-/.test(file)) tldrawHits.push(file);
    else {
      const text = await fs.readFile(path.join(DIST, file), "utf8");
      if (TLDRAW_MARKS.some((re) => re.test(text))) tldrawHits.push(file);
    }
  }
  if (tldrawHits.length) {
    failed++;
    failures.push(`tldraw in the build output: ${tldrawHits.join(", ")}`);
    console.log(`  ✗ tldraw is in the build output: ${tldrawHits.join(", ")}`);
  } else console.log("  ✓ tldraw absent from the build output");

  // C2: the budget that matters for startup is the SUM of what index.html
  // loads before the app can run (its entry script + every modulepreload),
  // not each file alone. Measured 448 KB (18.10); goal 250 KB. Ratchet down
  // as startup work moves out of the eager graph.
  const STARTUP_BUDGET_KB = 460;
  try {
    const html = await fs.readFile(path.join(process.cwd(), "dist", "index.html"), "utf8");
    const startup = [...new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]))];
    let sum = 0;
    for (const f of startup) sum += gzipSync(await fs.readFile(path.join(DIST, f))).length / 1024;
    const ok = sum <= STARTUP_BUDGET_KB;
    if (!ok) {
      failed++;
      failures.push(`startup total: ${sum.toFixed(1)} KB / ${STARTUP_BUDGET_KB} KB`);
    }
    console.log(`  ${ok ? "✓" : "✗"} startup total (${startup.length} files) ${format(sum)} / ${format(STARTUP_BUDGET_KB)}`);
    const jsonAt0 = process.argv.indexOf("--json");
    if (jsonAt0 !== -1) classes["startup total"] = { kb: sum, files: startup.length };
  } catch {
    /* no dist/index.html (partial build) — per-file budgets still apply */
  }
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
    const round = (x) => Math.round(x * 10) / 10;
    const out = { totalKb: round(total), classes: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, { kb: round(v.kb), files: v.files }])) };
    await fs.writeFile(process.argv[jsonAt + 1], JSON.stringify(out, null, 2) + "\n");
  }
  if (failed > 0) {
    // One summary at the very end, so a long build log needs no scrolling (or paging) to find them.
    console.error(`\n✗ budget failures (${failed}):\n  ${failures.join("\n  ")}`);
    console.error(
      `\n✗ ${failed} chunk${failed === 1 ? "" : "s"} exceeded its budget. ` +
        `Edit scripts/bundle-budget.mjs if the increase is intentional.\n`,
    );
    process.exit(1);
  }
  console.log("\n✓ All chunks within budget.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
