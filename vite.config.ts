/// <reference types="vitest" />
import { defineConfig as defineViteConfig, searchForWorkspaceRoot } from "vite";
import type { Plugin, UserConfig as ViteUserConfig } from "vite";
import { cspEndpointsPlugin } from "./src/build/cspEndpoints";
import { laneCacheDir } from "./src/build/laneCache";
import { webrManifestPlugin } from "./src/build/webrManifest";
import { LOCALES, whatsNew } from "./scripts/lib/whats-new.mjs";
import { viteEnvGatePlugin } from "./src/build/viteEnvGate";

interface VitestConfig {
  test?: {
    environment?: string;
    include?: string[];
    globals?: boolean;
    css?: boolean;
    setupFiles?: string[];
    alias?: Record<string, string>;
    coverage?: {
      provider?: "v8" | "istanbul";
      reporter?: string[];
      reportsDirectory?: string;
      include?: string[];
      exclude?: string[];
    };
  };
}

const defineConfig = (config: ViteUserConfig & VitestConfig) =>
  defineViteConfig(config as ViteUserConfig);
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";

/**
 * Version of a self-hosted runtime package. Its files keep fixed names
 * (no content hash), so the runtime cache is named per version: an
 * upgrade starts a fresh cache instead of serving the old files forever.
 */
function runtimeVersion(pkg: string): string {
  try {
    const file = path.resolve(__dirname, "node_modules", pkg, "package.json");
    return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "0";
  } catch {
    return "0";
  }
}

// y-websocket is an OPTIONAL peer dep. If the user has installed it
// (i.e. `node_modules/y-websocket` exists), Vite resolves the import
// normally. Otherwise we alias to a no-op stub so the dev server +
// production build don't fail on the unresolved import — the runtime
// try/catch in src/collab/yjs.ts handles the no-op cleanly.
const yWebsocketInstalled = existsSync(
  path.resolve(__dirname, "node_modules/y-websocket"),
);

/**
 * The en-US Hunspell files of dictionary-en, for the English spelling
 * checker (plan 6.10). The package's own entry reads them with node:fs and
 * its exports map hides them, so they are read here.
 *
 * They are data, not code: the app fetches them same-origin from dict/
 * (src/ai/englishDictionary.ts), and the PWA precaches them with the other
 * dict/*.txt files, so spelling works offline and nothing leaves the
 * device, while ≈ 0.55 MB of word list stays out of the JS chunks.
 * `lumen-dictionary-en-files` emits them into the build and serves them in
 * dev (the .txt suffix is for that precache pattern). Under Vitest there is
 * no server to fetch from, so `virtual:lumen-dictionary-en` carries them
 * inline there, and is `inline = null` everywhere else.
 */
const DICTIONARY_EN_ID = "virtual:lumen-dictionary-en";
const DICTIONARY_EN_FILES = { "dict/en-US.aff.txt": "index.aff", "dict/en-US.dic.txt": "index.dic" } as const;
const readDictionaryEn = (file: string) => readFileSync(path.resolve(__dirname, "node_modules/dictionary-en", file), "utf8");
const dictionaryEn = {
  name: "lumen-dictionary-en",
  resolveId(id: string) {
    return id === DICTIONARY_EN_ID ? "\0" + DICTIONARY_EN_ID : null;
  },
  load(id: string) {
    if (id !== "\0" + DICTIONARY_EN_ID) return null;
    if (!process.env.VITEST) return "export const inline = null;\n";
    const aff = readDictionaryEn("index.aff");
    const dic = readDictionaryEn("index.dic");
    return `export const inline = { aff: ${JSON.stringify(aff)}, dic: ${JSON.stringify(dic)} };\n`;
  },
};
/** Main build only (not the worker build), so each file is emitted once. */
const dictionaryEnFiles: Plugin = {
  name: "lumen-dictionary-en-files",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const file = DICTIONARY_EN_FILES[(req.url ?? "").split("?")[0].replace(/^\//, "") as keyof typeof DICTIONARY_EN_FILES];
      if (!file) return next();
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(readDictionaryEn(file));
    });
  },
  generateBundle() {
    for (const [fileName, file] of Object.entries(DICTIONARY_EN_FILES)) this.emitFile({ type: "asset", fileName, source: readDictionaryEn(file) });
  },
};

/**
 * Tiny Vite plugin: rewrites clean URLs (`/roadmap`, `/landing`) to
 * their `.html` counterparts in `public/`. Production deployments
 * usually handle this at the proxy layer; this keeps dev / preview
 * parity with production so the status-bar link works locally.
 */
const cleanUrlAliases = {
  name: "lumen-clean-url-aliases",
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/roadmap") req.url = "/roadmap.html";
      else if (req.url === "/landing") req.url = "/landing.html";
      else if (req.url === "/benchmarks") req.url = "/benchmarks.html";
      next();
    });
  },
  configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/roadmap") req.url = "/roadmap.html";
      else if (req.url === "/landing") req.url = "/landing.html";
      else if (req.url === "/benchmarks") req.url = "/benchmarks.html";
      next();
    });
  },
};

/** Dev / preview CORS: the playground runner's opaque origin and localhost. */
const playgroundCorsOrigin = ["null", /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/];

/**
 * A lane (scripts/lane.sh) symlinks node_modules from another checkout; Vite
 * resolves the link, so fonts and other files served from there would fall
 * outside its default allow list. Allow the real node_modules too.
 */
const devFsAllow = (() => {
  const allow = [searchForWorkspaceRoot(process.cwd())];
  try {
    const real = realpathSync(path.resolve(__dirname, "node_modules"));
    if (!real.startsWith(allow[0] + path.sep)) allow.push(real);
  } catch {
    /* no node_modules yet */
  }
  return allow;
})();

/**
 * The staging script can rewrite runtime files (copy-webr.mjs prepends the
 * worker isolation prelude): its hash is part of the cache name, so a fix
 * there reaches installed apps without a runtime upgrade.
 */
function stagingRevision(dir: string): string {
  // webR's preludes and file list live in webrRuntime.json, shared by its
  // staging script and the in-app download (plan W1.34).
  const inputs = [`scripts/copy-${dir}.mjs`, ...(dir === "webr" ? ["src/plugins/r/webrRuntime.json"] : [])]
    .map((f) => path.resolve(__dirname, f))
    .filter((f) => existsSync(f));
  if (!inputs.length) return "0";
  const h = createHash("sha256");
  for (const f of inputs) h.update(readFileSync(f));
  return h.digest("hex").slice(0, 8);
}

/** Runtime caches of the self-hosted language runtimes, named per version and staging revision. */
const RUNTIME_CACHES = (
  [
    ["webr", "webr"],
    ["ruby", "@ruby/3.4-wasm-wasi"],
    ["pyodide", "pyodide"],
    // ONNX Runtime Web for transformers.js (local transcription, embeddings).
    ["ort", "onnxruntime-web"],
    // Excalidraw fonts (the canvas), served from this origin.
    ["excalidraw", "@excalidraw/excalidraw"],
  ] as const
).map(([dir, pkg]) => ({ dir, cacheName: `lumen-runtime-${dir}-${runtimeVersion(pkg)}-${stagingRevision(dir)}` }));

/**
 * Vendor chunk for a module (null: automatic chunking). Used as Rolldown
 * code-splitting groups; see build.rolldownOptions.output.codeSplitting.
 */
function vendorChunk(id: string): string | undefined {
  // Vite's tiny preload helper (a VIRTUAL module — no node_modules in
  // its id, so this must sit above the guard). Auto-placement parked
  // it inside vendor-shiki, which made that 258KB chunk a STATIC dep
  // of main; pin it to the always-eager react chunk instead.
  if (id.includes("vite/preload-helper") || id.includes("vite/modulepreload-polyfill"))
    return "vendor-react";
  if (!id.includes("node_modules")) return undefined;
  // ── Shared text-processing families get their own chunks ──
  // The eager preview pipeline uses remark/micromark/unified and
  // hast-util-to-html; the LAZY editors (milkdown, shiki) use them
  // too. Without explicit homes Rollup co-located these shared
  // modules inside vendor-milkdown / vendor-shiki, which made main
  // statically import those chunks and EXECUTE all of milkdown +
  // prosemirror + shiki at boot (~400KB gz) just to reach the
  // helpers. (Diagnosed via sourcemap residents, 2026-06-10.)
  if (/node_modules\/lodash(-es)?\//.test(id)) return "vendor-lodash";
  // Inline HTML support (rehype-raw → hast-util-raw → parse5, ~45 KB gz) is
  // imported only for documents with raw HTML. In vendor-unified (eager) it
  // made the whole HTML parser a startup dependency; left out of the groups
  // it stays in the lazy chunk of its dynamic import.
  if (/node_modules\/(rehype-raw|hast-util-raw|hast-util-from-parse5|hast-util-to-parse5|parse5|parse5-[a-z-]+|entities|hastscript|vfile-location)\//.test(id)) return undefined;
  if (
    /node_modules\/(micromark|mdast-util-|remark-|rehype-(?!katex)|unified|vfile|unist-util-|hast-util-|html-void-elements|property-information|space-separated-tokens|comma-separated-tokens|web-namespaces|stringify-entities|character-entities|character-reference-invalid|is-(alphabetical|alphanumerical|decimal|hexadecimal|plain-obj)|bail|trough|devlop|extend|zwitch|ccount|longest-streak|markdown-table|escape-string-regexp|decode-named-character-reference)/.test(id)
  ) return "vendor-unified";
  if (id.includes("@floating-ui/")) return "vendor-floating";
  if (id.includes("@codemirror") || id.includes("@lezer")) return "vendor-codemirror";
  if (id.includes("@milkdown") || id.includes("prosemirror")) return "vendor-milkdown";
  if (id.includes("mermaid")) return "vendor-mermaid";
  if (id.includes("@hpcc-js/wasm")) return "vendor-graphviz";
  if (id.includes("echarts") || id.includes("zrender")) return "vendor-echarts";
  if (id.includes("leaflet")) return "vendor-leaflet";
  // <model-viewer> web component + its three.js / lit runtime —
  // lazy-loaded by Model3DBlock only when a 3D block is visible.
  if (/node_modules\/(@google\/model-viewer|three|lit|lit-html|lit-element|@lit|@lit-labs|@monogrid)\//.test(id))
    return "vendor-modelviewer";
  // KaTeX + its mhchem extension + rehype-katex all share the
  // same chunk. Without rehype-katex in the chunk, the
  // production build hit a TDZ error ("Cannot access 'xn'
  // before initialization") at the chunk boundary because
  // rehype-katex re-exports katex internals that mhchem mutates.
  if (
    id.includes("katex") ||
    id.includes("rehype-katex") ||
    id.includes("mathml-tag-names")
  ) return "vendor-katex";
  // Shiki's per-language and per-theme grammars live in
  // @shikijs/langs and @shikijs/themes and are imported dynamically
  // by shiki's web-bundle; let Rollup keep each one as its own
  // chunk so a doc that uses TypeScript+JSON only fetches those
  // two grammar chunks instead of the entire 9 MB language pack.
  if (id.includes("@shikijs/langs/")) return undefined;
  if (id.includes("@shikijs/themes/")) return undefined;
  if (id.includes("shiki") || id.includes("@shikijs")) return "vendor-shiki";
  if (id.includes("isomorphic-git") || id.includes("lightning-fs")) return "vendor-git";
  // Excalidraw (the canvas, plan 4.19): its own lazy chunk; its Mermaid → diagram
  // dialog loads on demand and stays apart from the Mermaid block renderer.
  // A code-splitting group takes every module it matches, dynamic imports
  // included, so one "vendor-excalidraw" group folded into the canvas chunk
  // what Excalidraw itself loads only on demand: every translation
  // (dist/<env>/locales/…, one file per language, of which the UI needs one)
  // and the font-subsetting code (subset-shared / subset-worker with the
  // harfbuzz and woff2 wasm, used only when exporting). Each of those keeps a
  // chunk of its own, still named vendor-excalidraw-… so the PWA leaves it to
  // the runtime cache and the budget counts it as Excalidraw.
  const exSub = /@excalidraw\/excalidraw\/dist\/(?:prod|dev)\/([^/]+)\/([^/]+?)\.js$/.exec(id);
  if (exSub) return `vendor-excalidraw-${exSub[1]}-${exSub[2]}`.replace(/[^A-Za-z0-9-]/g, "_");
  if (/@excalidraw\/excalidraw\/dist\/(prod|dev)\/subset-/.test(id)) return "vendor-excalidraw-subset";
  // Excalidraw's own build splits its code into shared chunk-<hash>.js files
  // (the font-subsetting wasm among them, loaded on export only). In one
  // group they all became the canvas chunk; each keeps a chunk of its own,
  // so the ones Excalidraw imports on demand stay on demand.
  const exChunk = /@excalidraw\/excalidraw\/dist\/(?:prod|dev)\/(chunk-[^/]+?)\.js$/.exec(id);
  if (exChunk) return `vendor-excalidraw-${exChunk[1]}`.replace(/[^A-Za-z0-9-]/g, "_");
  if (id.includes("@excalidraw/mermaid-to-excalidraw")) return "vendor-excalidraw-mermaid";
  if (id.includes("@excalidraw/")) return "vendor-excalidraw";
  // The web clipper's extractors (plan 4.15): vendor code apart from the clip
  // logic, loaded together with it, on the first clip only.
  if (/node_modules\/(defuddle|@mozilla\/readability|turndown)\//.test(id)) return "vendor-clipper";
  // Anchor `y-*` to node_modules/y-… so we don't accidentally
  // match lucide-react icon file paths that contain `y-` in
  // the filename (e.g. "y-axis.js"). Previously this broad
  // match pulled lucide-react into vendor-yjs, which then
  // cross-imported into vendor-katex and caused a Temporal
  // Dead Zone error at module init time.
  if (
    id.includes("/yjs/") ||
    id.includes("node_modules/yjs") ||
    /node_modules\/y-[a-z]/.test(id)
  ) return "vendor-yjs";
  // @sentry/react's path matches the "/react/" rule below; without
  // this guard the lazily-imported SDK is merged back into the
  // EAGER vendor-react chunk — and a dynamic import can't be
  // tree-shaken, so the full SDK doubled that chunk. Keep Sentry
  // in its own chunk: it loads lazily (or never, without a DSN).
  if (id.includes("@sentry")) return "vendor-sentry";
  // React and react-dom MUST live in the same chunk: they share
  // internal helpers and have a circular dependency that
  // breaks (TDZ "Cannot set properties of undefined") when
  // rollup splits them. Both are small + always loaded
  // together; splitting saves nothing in real-world apps.
  // Anchored to node_modules/: `@use-gesture/react/` also contains "/react/".
  // react-dom/server is only for HTML export (a dynamic import): keep it out
  // of the eager chunk. It depends on react, not on react-dom's client.
  if (/node_modules\/react-dom\/(server|cjs\/react-dom-server)/.test(id)) return undefined;
  if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
  return undefined;
}

const viteCacheDir = laneCacheDir(__dirname);

/**
 * "What's new" (plan 14.6): this version's notes from CHANGELOG.md and the
 * translations in changelog/<locale>.md, as `virtual:lumen-whats-new` — a
 * small lazy chunk (so it is precached and works offline), loaded only
 * when the app was updated or the user asks for it.
 */
const APP_VERSION = (JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string }).version;
const WHATS_NEW_ID = "virtual:lumen-whats-new";
const whatsNewNotes = {
  name: "lumen-whats-new",
  resolveId(id: string) {
    return id === WHATS_NEW_ID ? "\0" + WHATS_NEW_ID : null;
  },
  load(id: string) {
    if (id !== "\0" + WHATS_NEW_ID) return null;
    const read = (f: string) => (existsSync(path.resolve(__dirname, f)) ? readFileSync(path.resolve(__dirname, f), "utf8") : "");
    const translations = Object.fromEntries(LOCALES.filter((l) => l !== "en").map((l) => [l, read(`changelog/${l}.md`)]));
    return `export default ${JSON.stringify(whatsNew(APP_VERSION, read("CHANGELOG.md"), translations))};\n`;
  },
};

export default defineConfig({
  // A lane's symlinked node_modules is shared: its Vite cache stays in the worktree (src/build/laneCache.ts).
  ...(viteCacheDir ? { cacheDir: viteCacheDir } : {}),
  // The page deletes `lumen-runtime-*` caches of superseded versions
  // (src/lib/runtimeCaches.ts): Workbox only cleans its precache.
  define: {
    __LUMEN_RUNTIME_CACHES__: JSON.stringify(RUNTIME_CACHES.map((c) => c.cacheName)),
    __LUMEN_VERSION__: JSON.stringify(APP_VERSION),
    // window.__lumenTest for Playwright (src/testing/e2eHooks.ts): a literal,
    // so a build without VITE_E2E=1 drops the hook and its chunk entirely.
    __LUMEN_E2E__: JSON.stringify(process.env.VITE_E2E === "1"),
  },
  // Worker bundles get only these plugins (plus Vite's own).
  worker: { plugins: () => [dictionaryEn] },
  plugins: [
    // W4.4: a VITE_* not on security/vite-env-allowlist.json fails the build.
    viteEnvGatePlugin(),
    react(),
    whatsNewNotes,
    cleanUrlAliases,
    dictionaryEn,
    dictionaryEnFiles,
    // runtimes/webr.json: what the R block's webR download is checked against (plan W1.34).
    webrManifestPlugin(__dirname),
    // Adds the deployment's own worker origins (VITE_*_ENDPOINT …) to the
    // CSP connect-src of index.html, dist/_headers and the nginx image.
    cspEndpointsPlugin(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "icons/*.png"],
      // The one manifest. (public/manifest.json used to be a second one,
      // linked from index.html, pointing at icons that did not exist and
      // disagreeing on the colours; its share/file handlers live here now.)
      manifest: {
        name: "Lumen — Markdown, illuminated",
        short_name: "Lumen",
        description:
          "A markdown editor that turns text and data into beautiful documents.",
        // Same accent as <meta name="theme-color"> in index.html; the dark
        // page background from index.css (hsl(224 24% 7%)).
        theme_color: "#7c5cfc",
        background_color: "#0e0f16",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        categories: ["productivity", "utilities", "developer"],
        icons: [
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "New Document", short_name: "New", url: "/?action=new", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
          { name: "Command Palette", short_name: "Commands", url: "/?action=palette", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
          // Plan 4.16: a line straight into inbox.md (src/ui/QuickCapture.tsx).
          { name: "Quick Capture", short_name: "Capture", url: "/?capture=1", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
          { name: "Voice note", short_name: "Voice", url: "/?capture=voice", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
        ],
        // GET: the app reads ?title / ?text / ?url on launch (src/pwa/launch.ts)
        // and appends what was shared to inbox.md (plan 4.16).
        // A POST target with files would need a custom service worker.
        share_target: {
          action: "/",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
        file_handlers: [
          {
            action: "/",
            accept: {
              "text/markdown": [".md", ".markdown", ".mdown", ".mkd"],
              "text/plain": [".txt"],
            },
          },
        ],
        launch_handler: { client_mode: "navigate-existing" },
      },
      workbox: {
        // Precache what offline use needs from the first visit (plan 8.5):
        // the app's chunks, the self-hosted fonts (Hebrew included, B8),
        // Shiki's core and its two themes, and the small workers (search,
        // Hebrew spelling, Graphviz, Lua, Ruby glue, PDF.js). Heavy
        // on-demand vendor chunks (Mermaid, Excalidraw, ECharts, CodeMirror,
        // Milkdown…) are cached by the runtime cache when first used.
        // The precache is ~16 MB; `npm run budget` prints it.
        // 1.4 MB: PDF.js's worker (pdf.worker.min.mjs, ~1.3 MB) is the
        // largest file that must be in it; everything bigger is either in
        // globIgnores below or a vendor chunk the runtime cache takes.
        maximumFileSizeToCacheInBytes: 1.4 * 1024 * 1024,
        // One self-contained sw.js. Production serves
        // `require-trusted-types-for 'script'` (public/_headers), which also
        // applies to the service worker: the default split build's
        // importScripts("workbox-*.js") is blocked there, leaving an
        // "activated" worker with no precache and no routes (no offline).
        inlineWorkboxRuntime: true,
        // No sw.js.map in the build (plan 11.5).
        sourcemap: false,
        globPatterns: ["**/*.{js,mjs,css,html,svg,wasm,woff2}", "dict/*.txt"],
        // Exclude heavy vendor chunks that are loaded on-demand via dynamic
        // import — these will be cached at runtime when first fetched.
        globIgnores: [
          // Shiki's core (vendor-shiki, with its wasm engine) IS precached:
          // code highlighting works offline from the first visit. Its ~220
          // rarer grammars stay out (14 MB); the common ones and the two
          // themes in use are emitted outside shiki-langs/ (see output).
          "**/shiki-langs/**",
          "**/vendor-mermaid-*.js",
          "**/vendor-excalidraw-*.js",
          // Excalidraw fonts (13 MB with the CJK set; scripts/copy-excalidraw.mjs): fetched as text is drawn.
          "excalidraw/**",
          "**/vendor-echarts-*.js",
          "**/vendor-graphviz-*.js",
          "**/vendor-codemirror-*.js",
          "**/vendor-milkdown-*.js",
          "**/vendor-leaflet-*.js",
          "**/vendor-modelviewer-*.js",
          "**/vendor-katex-*.js",
          "**/vendor-git-*.js",
          // TypeScript compiler + lib files for the opt-in code-block checks
          // (several MB; fetched only when the user enables the setting).
          "**/tsCheck.worker-*.js",
          // web-llm inference worker (~6 MB; fetched on the first
          // in-browser AI prompt, cached by the browser like any script).
          "**/webllm.worker-*.js",
          // transformers.js worker (local transcription / embeddings) and
          // the ONNX Runtime wasm it loads (~40 MB, staged by copy-ort).
          "**/transformers.worker-*.js",
          "ort/**",
          // QuickJS for plugin logic (~490 KB, staged by copy-quickjs): fetched when a plugin loads.
          "quickjs/**",
          // The same wasm, if the bundler also emits it from the package's `new URL(…, import.meta.url)`; the worker loads /quickjs/.
          "**/emscripten-module*.wasm",
          // tesseract.js worker + LSTM cores (~12 MB, scripts/copy-tesseract.mjs):
          // fetched on the first OCR.
          "tesseract/**",
          // onnxruntime-web also references its wasm by `new URL(…,
          // import.meta.url)`, so Vite emits a copy under assets/; the
          // worker loads the staged public/ort/ files instead.
          "**/ort-wasm-*.wasm",
          // Pyodide (~13 MB, staged into public/ by prebuild) loads on the
          // first live-python Run; its 9.6 MB wasm would also trip the
          // precache size limit and fail `npm run build`.
          "pyodide/**",
          // webR (R in WebAssembly, ~45 MB) is not part of the build (GPL-3.0
          // binaries, plan W1.34): the user downloads it from the R block into
          // the webr runtime cache below. Only a deployment that serves its
          // own copy (`npm run webr:local`) has webr/ here.
          "webr/**",
          // ruby.wasm (~30 MB, staged by scripts/copy-ruby.mjs): fetched on
          // the first live-ruby Run.
          "ruby/**",
          // Reading fonts (plan W3.5): downloaded only when the person picks
          // one in Reading options, then cached (runtime cache below).
          "fonts/reading/**",
          // Reading fonts (plans W3.5, W5.6): downloaded only when the person
          // picks one, then cached (runtime cache below).
          "fonts/reading/**",
        ],
        runtimeCaching: [
          {
            // Google Fonts CSS (mutable, but small)
            urlPattern: ({ url }) =>
              url.origin === "https://fonts.googleapis.com",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "lumen-fonts-css" },
          },
          {
            // Google Fonts files (immutable hashed names)
            urlPattern: ({ url }) =>
              url.origin === "https://fonts.gstatic.com",
            handler: "CacheFirst",
            options: {
              cacheName: "lumen-fonts",
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            // Reading fonts (plan W3.5): same origin, fetched on first choice,
            // then served from this cache — offline too.
            urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.includes("/fonts/reading/"),
            handler: "CacheFirst" as const,
            options: { cacheName: "lumen-reading-fonts", cacheableResponse: { statuses: [200] } },
          },
          {
            // Reading fonts (plans W3.5, W5.6): same origin, fetched on first choice,
            // then served from this cache — offline too.
            urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.includes("/fonts/reading/"),
            handler: "CacheFirst" as const,
            options: { cacheName: "lumen-reading-fonts", cacheableResponse: { statuses: [200] } },
          },
          // Self-hosted language runtimes (webR, ruby.wasm, Pyodide) are
          // kept out of the precache (tens of MB each) but cached the first
          // time a live block loads them, so they also work offline later.
          ...RUNTIME_CACHES.map(({ dir, cacheName }) => ({
            urlPattern: new RegExp(`/${dir}/`),
            handler: "CacheFirst" as const,
            options: { cacheName, cacheableResponse: { statuses: [200] } },
          })),
          {
            // D1: every other hashed chunk (Shiki and its language grammars
            // and themes, editor, blocks…) is cached the first time it is
            // used, so it also works offline afterwards. Hashed names never
            // change content, so CacheFirst is safe.
            urlPattern: ({ url }) =>
              url.origin === self.location.origin &&
              /\/assets\/.+\.(js|mjs|css|wasm)$/.test(url.pathname) &&
              !/\/assets\/vendor-(mermaid|excalidraw|excalidraw-mermaid|echarts|graphviz|codemirror|milkdown|leaflet|modelviewer|katex|git|yjs|react|react-dom)-/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "lumen-chunks",
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 60 },
            },
          },
          {
            // Large on-demand vendor chunks (Mermaid, Excalidraw, ECharts, etc.)
            // Cached at runtime when first loaded via dynamic import.
            urlPattern: ({ url }) =>
              url.origin === self.location.origin &&
              /\/assets\/vendor-(mermaid|excalidraw|excalidraw-mermaid|echarts|graphviz|codemirror|milkdown|leaflet|modelviewer|katex|git|yjs|react|react-dom)-/.test(url.pathname),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "lumen-vendor-chunks",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        // Don't enable in dev — the SW intercepts HMR.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: [
      // isomorphic-git ≥ 1.37 maps "." only to index.cjs — the Node build,
      // which hashes packfiles with require("crypto").createHash. In the
      // browser that is an empty shim and every clone failed with
      // "createHash is not a function" (found by the G3 e2e, plan 3.7).
      // index.js is the package's own browser/ESM build (sha.js).
      // Exact match only (a regex): the subpaths (http/web …) resolve normally.
      { find: /^isomorphic-git$/, replacement: path.resolve(__dirname, "node_modules/isomorphic-git/index.js") },
      ...Object.entries({
      "@": path.resolve(__dirname, "./src"),
      // remark-math only uses the `math` syntax extension, but the
      // package index also re-exports `mathHtml` (lib/html.js), which
      // imports katex. html.js is tree-shaken, yet katex (not marked
      // side-effect-free) survived as a bare `import "./vendor-katex"`
      // in the EAGER vendor-unified chunk — ~84 KB gz on every boot.
      // Point at the syntax module directly so KaTeX only loads via the
      // dynamic ./renderer/katexPlugin import (A7 lever 1/3).
      "micromark-extension-math": path.resolve(
        __dirname,
        "node_modules/micromark-extension-math/lib/syntax.js",
      ),
      // y-websocket is OPTIONAL — only alias to the stub when the real
      // package isn't installed. This way deployments that DO install
      // y-websocket explicitly still get the real implementation, while
      // bare `npm install` (most users, all CI runs) doesn't crash on
      // the unresolved import. In test mode the test-level vi.mock
      // overrides whichever resolution wins here.
      ...(yWebsocketInstalled
        ? {}
        : {
            "y-websocket": path.resolve(
              __dirname,
              "src/__tests__/stubs/y-websocket.ts",
            ),
          }),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  server: {
    port: 5173,
    host: true,
    fs: { allow: devFsAllow },
    // The Web Playground runner (sandboxed iframe, origin "null") loads its
    // module scripts with CORS; allow it and local pages, nothing else.
    cors: { origin: playgroundCorsOrigin },
  },
  // y-websocket is an optional peer-dep (see src/collab/yjs.ts). The
  // Rollup `external` covers prod builds, but Vite's dev server uses
  // esbuild dep-optimization which trips on the unresolved import. Tell
  // Vite to skip pre-bundling it; the dynamic `await import(...)` will
  // fail at runtime if the user hasn't installed the package, and the
  // existing try/catch falls back to WebRTC-only collab cleanly.
  optimizeDeps: {
    exclude: ["y-websocket"],
    // Deps reached only from lazily-loaded workers/blocks are otherwise
    // discovered on first use, and Vite then FULL-RELOADS the page
    // ("optimized dependencies changed. reloading") — losing the user's
    // unsaved edits in dev and flaking the live-lua e2e. Pre-bundle them.
    // The git modules (safe git, plan 3.3) load on the first git command.
    include: ["wasmoon", "isomorphic-git", "isomorphic-git/http/web", "@isomorphic-git/lightning-fs", "buffer"],
    // The dep scanner crawls the HTML entries and every import() they reach,
    // but never a `new Worker(new URL("./x.worker.ts", import.meta.url))`.
    // So @hpcc-js/wasm (graphviz), @ruby/wasm-wasi, transformers.js and the
    // rest were found only when a worker first started — and that full reload
    // hit every open page. With Playwright's parallel workers on a cold CI dev
    // server, one graphviz or live-ruby test reloaded the pages of the tests
    // next to it (the error-paths CSV and graphviz flakes, live-ruby, plan
    // 0.5). Scanning the worker files too finds those deps before the first
    // page loads. Setting `entries` replaces the default (the HTML inputs),
    // so they are listed here as well.
    entries: ["index.html", "playground-runner.html", "livejs-runner.html", "src/**/*.worker.ts"],
  },
  // ε.4.3 — clean-URL aliases for the auxiliary HTML pages so dev links
  // like `/roadmap` and `/landing` work without the `.html` suffix.
  // Production deployments are expected to handle this at the reverse
  // proxy layer (Cloudflare Pages, nginx).
  preview: {
    port: 5173,
    cors: { origin: playgroundCorsOrigin },
  },
  // The live-js runner's CSP allows its scripts by this nonce (WebKit doesn't match
  // 'self' inside an opaque-origin sandboxed frame). Vite stamps it on every script
  // and modulepreload tag it writes; other pages' policies simply ignore it.
  html: { cspNonce: "lumen-livejs-runner" },
  build: {
    target: "es2022",
    // No source maps in what ships (plan 11.5, F7): they publish the whole
    // source next to the app and grow the desktop bundle. LUMEN_SOURCEMAP=1
    // turns them on for a local investigation; scripts/bundle-budget.mjs
    // fails a build that has any.
    sourcemap: process.env.LUMEN_SOURCEMAP === "1",
    // Warn early if a single chunk crosses 500 KiB; the renderer pipeline
    // and editor frameworks split out as their own chunks today.
    chunkSizeWarningLimit: 500,
    modulePreload: {
      // A lazy translation chunk needs nothing the page has not loaded
      // already; without this, each of the 56 locale loaders in the startup
      // i18n chunk carried its own preload list (+1.3 KB gzipped, plan 0.3).
      resolveDependencies: (filename, deps) => (/(^|\/)locale-[^/]+\.js$/.test(filename) ? [] : deps),
    },
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        landing: path.resolve(__dirname, "public/landing.html"),
        roadmap: path.resolve(__dirname, "public/roadmap.html"),
        benchmarks: path.resolve(__dirname, "public/benchmarks.html"),
        // Web Playground runner: the page inside the block's sandboxed iframe.
        playground: path.resolve(__dirname, "playground-runner.html"),
        // live-js runner: the hidden sandboxed iframe live-js code runs in (T48).
        livejs: path.resolve(__dirname, "livejs-runner.html"),
      },
      // `y-websocket` is an OPTIONAL runtime dep (see comments in
      // src/collab/yjs.ts). It's not in package.json — users opt in by
      // installing it explicitly. Mark it external so Rollup doesn't
      // try to bundle it; if the user hasn't installed it, the dynamic
      // import in src/collab/yjs.ts catches the resolution failure and
      // the session falls back to WebRTC-only.
      external: ["y-websocket"],
      output: {
        // Route Shiki per-language and per-theme grammar chunks into a
        // dedicated `assets/shiki-langs/` subfolder so the PWA precache
        // can glob-exclude them. They still load on demand through the
        // service-worker runtime cache when the user opens a code block.
        chunkFileNames(chunkInfo) {
          const id = chunkInfo.facadeModuleId ?? "";
          // The two themes the highlighter always loads stay precached (8.5).
          if (/@shikijs\/themes\/dist\/github-(dark|light)-default\./.test(id)) return "assets/[name]-[hash].js";
          if (id.includes("@shikijs/langs/") || id.includes("@shikijs/themes/")) {
            return "assets/shiki-langs/[name]-[hash].js";
          }
          // Prettier core + per-language plugins (lazy, src/editor/format.ts):
          // prefix them so the bundle budget can give them their own rule.
          if (id.includes("node_modules/prettier/")) {
            return "assets/prettier-[name]-[hash].js";
          }
          // Lazy translations (plan 0.3): locale-<lang>-<domain>-<hash>.js, not
          // eight anonymous "ai-<hash>.js" chunks per domain.
          const locale = /\/src\/i18n\/locales\/([^/]+)\/([^/]+)\.json$/.exec(id);
          if (locale) return `assets/locale-${locale[1]}-${locale[2]}-[hash].js`;
          // The entries' shared startup code (strict execution order puts it
          // in a common chunk) would be named after the checkout folder.
          if (!id && chunkInfo.name === path.basename(__dirname)) return "assets/app-[hash].js";
          return "assets/[name]-[hash].js";
        },
        // Vendor chunks as Rolldown code-splitting groups. Unlike Rollup's
        // manualChunks, a group by default also captures its modules'
        // dependencies: shared micromark / hast helpers then landed in
        // vendor-milkdown / vendor-shiki / vendor-katex, and the preview
        // pipeline pulled all of those into the startup graph. Each module
        // goes to its own family's chunk instead (strict execution order
        // keeps cross-chunk initialisation correct).
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [{ name: (id: string) => vendorChunk(id) ?? null, test: (id: string) => vendorChunk(id) !== undefined }],
        },
        strictExecutionOrder: true,
      },
    },
  },
  // ── Vitest ──────────────────────────────────────────────────────────
  test: {
    environment: "jsdom",
    // The VS Code extension's pure helpers are tested from the root suite too.
    include: ["src/__tests__/**/*.test.{ts,tsx}", "packages/vscode-lumen/test/**/*.test.ts"],
    globals: true,
    css: false,
    setupFiles: ["src/__tests__/setup.ts"],
    // `y-websocket` is intentionally absent from package.json (loaded at
    // runtime via dynamic import in src/collab/yjs.ts; users opt in by
    // installing it explicitly). Without an alias, Vitest's import
    // analyzer can't resolve `import("y-websocket")` in CI, even though
    // the test file then does `vi.mock(...)` to replace it. The stub
    // gives the analyzer a real file to resolve; the test's vi.mock
    // still wins at runtime.
    alias: {
      "y-websocket": path.resolve(__dirname, "src/__tests__/stubs/y-websocket.ts"),
    },
    coverage: {
      provider: "v8",
      // HTML reporter was dropped in round-25 — istanbul's html writer
      // crashed with `ERR_INVALID_ARG_VALUE` when mirroring Vite's
      // null-byte-prefixed virtual modules (`\x00virtual:…`) under
      // `coverage/`. CI only needs the JSON summary for the >=60% gate;
      // the text-summary prints to the build log for humans. Anyone who
      // wants a clickable HTML drilldown can opt-in by adding "html"
      // back locally.
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      // Without `include`, v8 reports every JS file executed during tests
      // — including ~3500 node_modules entries that artificially inflate
      // the total. Worse, the inflation isn't deterministic across
      // environments: locally the ratio came out at 97 %, in CI's
      // minimal install it dropped to 37 % (same source code), tripping
      // the >=60 % gate. Scope coverage to first-party src/ only — that's
      // what the gate is actually measuring.
      include: ["src/**/*.{ts,tsx}"],
      // Every folder of src/ is measured (plan 10.4: zero excluded
      // folders). Only three kinds of file stay out, each for a reason
      // that is not "hard to test":
      exclude: [
        // the tests themselves (and their helpers/stubs) are not product code;
        "src/__tests__/**",
        // type-only declarations emit no JavaScript, so there is nothing to run;
        "src/**/*.d.ts",
        // the boot entry: it patches window.prompt, starts the backup and
        // telemetry timers and mounts into #root at import time, so a test
        // importing it would leak those side effects into every later test.
        // Everything it wires up (App, ToastContainer, UpdateBanner, i18n
        // boot) is imported and covered on its own.
        "src/main.tsx",
      ],
    },
  },
});

