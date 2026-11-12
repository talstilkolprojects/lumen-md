/**
 * Where each test runs (plan W6.8): one list, read by the Vercel gate
 * (scripts/vercel-build.mjs, scripts/e2e-gate.mjs), by the nightly runner
 * (scripts/nightly/plan.mjs) and by the test that pins both
 * (src/__tests__/testTiers.test.ts).
 *
 * The Vercel preview build is the fast gate: it must end inside 38 of the
 * 45 minutes Vercel allows (GATE_BUDGET_MIN). The nightly host runs
 * everything: the whole vitest suite in VITEST_SHARDS shards and every e2e
 * spec in E2E_SHARDS shards on chromium, firefox and webkit. So nothing is
 * dropped: a suite named here is moved to the nightly run, never left out of
 * both, and the pin fails if a file listed here no longer exists.
 */

/** A Vercel preview build that runs past this many minutes fails (Vercel stops it at 45). */
export const GATE_BUDGET_MIN = 38;

/**
 * Vitest files that run only on the nightly host, not in the Vercel gate:
 * quality measurements over large golden sets, timing budgets, and suites
 * that load a whole language runtime or build a bundle. Each declares a long
 * timeout of its own (≥ 15 s). Correctness tests of the vault, sync,
 * encryption and history stay in the gate, however slow.
 */
export const VITEST_NIGHTLY_ONLY = [
  // golden sets: a score over hundreds of cases (plan 7.3)
  "src/__tests__/bm25Golden.test.ts",
  "src/__tests__/spellEnGolden.test.ts",
  "src/__tests__/clipperGolden.test.ts",
  "src/__tests__/mtChrf.test.ts",
  "src/__tests__/hebrewFreq.test.ts",
  // timing budgets: wall-clock limits that a 2-CPU build machine misses by noise
  "src/__tests__/wikiCompletePerf.test.ts",
  "src/__tests__/perfTti.test.ts",
  // whole runtimes or bundles: ruby.wasm, the browser build of isomorphic-git, local dictation
  "src/__tests__/liveRuby.test.ts",
  "src/__tests__/isomorphicGitBrowserBuild.test.ts",
  "src/__tests__/dictationLocal.test.ts",
];

/** The nightly vitest run, split in this many shards (`vitest run --shard=i/n`). */
export const VITEST_SHARDS = 2;

/**
 * The Vercel gate's e2e set on chromium: the app's core flows, chosen from
 * the specs that passed whole on the build machine (verify/e2e-probe run 4,
 * dpl_5uyX5tvs: 291 of 327 passed), about 50 tests in about 5 minutes on 2
 * workers. A spec joins once it passes in the nightly full run.
 */
export const E2E_FAST = [
  "e2e/smoke.spec.ts",
  "e2e/cmd-palette.spec.ts",
  "e2e/locale-switch.spec.ts",
  "e2e/rtl.spec.ts",
  "e2e/first-run.spec.ts",
  // privacy and security: nothing leaves the device unasked, the CSP holds
  "e2e/security.spec.ts",
  "e2e/csp-violations.spec.ts",
  "e2e/local-only-journey.spec.ts",
  "e2e/privacy.spec.ts",
  "e2e/remote-images.spec.ts",
  "e2e/monitoring.spec.ts",
  "e2e/secrets.spec.ts",
  // the notes themselves: the vault, the trash, capture, history
  "e2e/vault-folder.spec.ts",
  "e2e/trash-undo.spec.ts",
  "e2e/quick-capture.spec.ts",
  "e2e/version-history.spec.ts",
  "e2e/daily-notes.spec.ts",
  "e2e/embeds.spec.ts",
  "e2e/hover-preview.spec.ts",
  "e2e/wikilinks.spec.ts",
];

/** The gate's firefox set: the smoke spec (Firefox runs on the build image; WebKit does not). */
export const E2E_FIREFOX_FAST = ["e2e/smoke.spec.ts"];

/** The nightly e2e run: every spec, in this many shards per browser (`playwright test --shard=i/n`). */
export const E2E_SHARDS = 4;
export const E2E_BROWSERS = ["chromium", "firefox", "webkit"];

/**
 * The loopback collab server e2e/collab-persist.spec.ts starts. The page's
 * CSP must name it (connect-src), so the e2e builds (scripts/vercel-build.mjs
 * with VITE_E2E=1) and Playwright's dev server (playwright.config.ts) add it
 * through VITE_CSP_CONNECT_EXTRA; a production build never does.
 */
export const E2E_COLLAB_PORT = 4455;
export const E2E_COLLAB_WS = `ws://127.0.0.1:${E2E_COLLAB_PORT}`;
