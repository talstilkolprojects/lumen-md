/// <reference types="vitest" />
import { defineConfig as defineViteConfig } from "vite";
import type { UserConfig as ViteUserConfig } from "vite";
import { cspEndpointsPlugin } from "./src/build/cspEndpoints";

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
import { existsSync, readFileSync } from "node:fs";

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
 * The staging script can rewrite runtime files (copy-webr.mjs prepends the
 * worker isolation prelude): its hash is part of the cache name, so a fix
 * there reaches installed apps without a runtime upgrade.
 */
function stagingRevision(dir: string): string {
  const script = path.resolve(__dirname, `scripts/copy-${dir}.mjs`);
  return existsSync(script) ? createHash("sha256").update(readFileSync(script)).digest("hex").slice(0, 8) : "0";
}

/** Runtime caches of the self-hosted language runtimes, named per version and staging revision. */
const RUNTIME_CACHES = (
  [
    ["webr", "webr"],
    ["ruby", "@ruby/3.4-wasm-wasi"],
    ["pyodide", "pyodide"],
    // ONNX Runtime Web for transformers.js (local transcription, embeddings).
    ["ort", "onnxruntime-web"],
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
  if (id.includes("tldraw") || id.includes("@tldraw")) return "vendor-tldraw";
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
  if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
  return undefined;
}

export default defineConfig({
  // The page deletes `lumen-runtime-*` caches of superseded versions
  // (src/lib/runtimeCaches.ts): Workbox only cleans its precache.
  define: {
    __LUMEN_RUNTIME_CACHES__: JSON.stringify(RUNTIME_CACHES.map((c) => c.cacheName)),
  },
  plugins: [
    react(),
    cleanUrlAliases,
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
        ],
        // GET: the app reads ?title / ?text / ?url on launch (src/pwa/launch.ts).
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
        // Only precache small core files at install time. Heavy on-demand
        // vendor chunks (Mermaid, tldraw, ECharts, Graphviz, CodeMirror,
        // Milkdown) are fetched lazily by the runtime cache when first used.
        // This keeps the initial SW install under ~2 MB instead of ~12 MB.
        maximumFileSizeToCacheInBytes: 1024 * 1024,
        // One self-contained sw.js. Production serves
        // `require-trusted-types-for 'script'` (public/_headers), which also
        // applies to the service worker: the default split build's
        // importScripts("workbox-*.js") is blocked there, leaving an
        // "activated" worker with no precache and no routes (no offline).
        inlineWorkboxRuntime: true,
        globPatterns: ["**/*.{js,css,html,svg,wasm,woff2}"],
        // Exclude heavy vendor chunks that are loaded on-demand via dynamic
        // import — these will be cached at runtime when first fetched.
        globIgnores: [
          "**/vendor-shiki-*.js",
          "**/shiki-langs/**",
          "**/vendor-mermaid-*.js",
          "**/vendor-tldraw-*.js",
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
          // webR (R in WebAssembly, ~45 MB, staged by scripts/copy-webr.mjs)
          // loads on the first live-r Run.
          "webr/**",
          // ruby.wasm (~30 MB, staged by scripts/copy-ruby.mjs): fetched on
          // the first live-ruby Run.
          "ruby/**",
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
              !/\/assets\/vendor-(mermaid|tldraw|echarts|graphviz|codemirror|milkdown|leaflet|modelviewer|katex|git|yjs|react|react-dom)-/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "lumen-chunks",
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 60 },
            },
          },
          {
            // Large on-demand vendor chunks (Mermaid, tldraw, ECharts, etc.)
            // Cached at runtime when first loaded via dynamic import.
            urlPattern: ({ url }) =>
              url.origin === self.location.origin &&
              /\/assets\/vendor-(mermaid|tldraw|echarts|graphviz|codemirror|milkdown|leaflet|modelviewer|katex|git|yjs|react|react-dom)-/.test(url.pathname),
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
    alias: {
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
    },
  },
  server: {
    port: 5173,
    host: true,
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
    sourcemap: true,
    // Warn early if a single chunk crosses 500 KiB; the renderer pipeline
    // and editor frameworks split out as their own chunks today.
    chunkSizeWarningLimit: 500,
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
          if (id.includes("@shikijs/langs/") || id.includes("@shikijs/themes/")) {
            return "assets/shiki-langs/[name]-[hash].js";
          }
          // Prettier core + per-language plugins (lazy, src/editor/format.ts):
          // prefix them so the bundle budget can give them their own rule.
          if (id.includes("node_modules/prettier/")) {
            return "assets/prettier-[name]-[hash].js";
          }
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
      // Skip lazy-loaded vendor wrappers, build config, and the Tauri
      // / iOS native shells — they aren't unit-testable in jsdom.
      exclude: [
        "src/__tests__/**",
        "src/main.tsx",
        "src/App.tsx",
        "src/welcome.ts",
        "src/i18n/**",
        "src/plugins/EChart.tsx",
        "src/plugins/Model3DBlock.tsx",
        "src/plugins/MapBlock.tsx",
        "src/plugins/MermaidBlock.tsx",
        "src/plugins/HtmlPreviewBlock.tsx",
        "src/plugins/EmbedBlock.tsx",
        "src/layouts/**",
        "src/components/**",
        "src/views/DatabaseBlock.tsx",
        "src/renderer/components.tsx",
        "src/renderer/Preview.tsx",
        "src/renderer/Frontmatter.tsx",
      ],
    },
  },
});

