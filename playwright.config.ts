import { defineConfig, devices } from "@playwright/test";
import { E2E_COLLAB_WS } from "./scripts/test-tiers.mjs";

/**
 * Playwright configuration for Lumen end-to-end tests.
 *
 * Tests live in `e2e/` and run against the Vite dev server on port 5173.
 * Locally `npx playwright test` will spin up the server via `npm run dev`.
 * In CI, set `PLAYWRIGHT_BASE_URL` to skip starting a fresh server.
 */
const PORT = 5173;
/**
 * Tests tagged @nightly (e2e/perf-vault.spec.ts: typing in a 2 MB note)
 * run only in the "perf" project, which the nightly workflow runs against
 * the production build — never in the per-browser PR jobs.
 */
const NIGHTLY = /@nightly/;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
/** A Chromium executable to use when Playwright's own is not installed (docs/dev/ci-local.md). */
const CHROMIUM = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: "./e2e",
  // Compiles the app on the dev server before the first test (e2e/_warmup.ts).
  globalSetup: "./e2e/_warmup.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // No retries, on CI either (plan 0.5): a retry turns a flake into a pass
  // nobody looks at. A test that fails once is a bug to fix; the nightly
  // e2e-flake workflow runs the suite 5× per browser to find them first.
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", grepInvert: NIGHTLY, use: { ...devices["Desktop Chrome"], ...(CHROMIUM ? { launchOptions: { executablePath: CHROMIUM } } : {}) } },
    {
      name: "firefox",
      grepInvert: NIGHTLY,
      use: {
        ...devices["Desktop Firefox"],
        // Headless Firefox on CI runners (no GPU) blocks WebGL by default,
        // so live-glsl rendered its "WebGL is not available" error view.
        // Force the software WebGL path the way Chromium's SwiftShader
        // gives one to the chromium project.
        // Headless Firefox still found no GL driver on CI even with Mesa
        // installed (FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS), so CI runs it
        // headed under Xvfb (PW_FIREFOX_HEADED=1), where Mesa's llvmpipe
        // provides GLX.
        headless: !process.env.PW_FIREFOX_HEADED,
        launchOptions: {
          firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disabled": false, "webgl.out-of-process": false },
        },
      },
    },
    { name: "webkit", grepInvert: NIGHTLY, use: { ...devices["Desktop Safari"] } },
    // `npx playwright test --project=perf` (.github/workflows/nightly-perf.yml).
    { name: "perf", grep: NIGHTLY, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // webR is not part of the build (GPL-3.0, plan W1.34): the live-r specs
        // run against this deployment's own copy (`webr:local`), and the
        // download offer is tested with /webr/ answered 404.
        command: "npm run webr:local && npm run dev",
        // The page may reach the loopback collab server of e2e/collab-persist.spec.ts
        // (an e2e build adds the same origin: scripts/vercel-build.mjs).
        env: { VITE_CSP_CONNECT_EXTRA: [process.env.VITE_CSP_CONNECT_EXTRA, E2E_COLLAB_WS].filter(Boolean).join(" ") },
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
