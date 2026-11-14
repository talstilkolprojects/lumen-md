import { defineConfig, devices } from "@playwright/test";
import { snapshotUpdateMode } from "./scripts/lib/visualGate.mjs";

/**
 * Visual regression (plan 10.3): `npm run test:visual`.
 *
 * Runs locally (or in any sandbox with a browser) against the production
 * build served by `vite preview`; GitHub Actions is optional. Baselines live
 * in visual/__baselines__/<platform>/ and are made on the machine that will
 * compare them: `npm run visual:approve -- visual`, review the PNGs, commit them.
 * A missing baseline is a failure (`updateSnapshots: "none"`), so a new
 * surface can't pass unseen.
 *
 * Fixed for every shot: Chromium, a 1280×800 viewport at 1×, UTC and en-US
 * for the browser, the app's self-hosted fonts (src/fonts.ts), no service
 * worker, reduced motion, animations and the caret off (visual/stable.css).
 */
const PORT = 4181;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./visual",
  testMatch: /.*\.visual\.ts$/,
  snapshotPathTemplate: "{testDir}/__baselines__/{platform}/{arg}{ext}",
  // "none" except under `npm run visual:approve` (plan W10.B16).
  updateSnapshots: snapshotUpdateMode(process.env),
  timeout: 60_000,
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? "github" : [["list"], ["html", { outputFolder: "visual-results/report", open: "never" }]],
  outputDir: "visual-results/artifacts",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      stylePath: "./visual/stable.css",
      // Same machine, same fonts: anti-aliasing noise only.
      threshold: 0.2,
      maxDiffPixels: 30,
    },
  },
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // The production bundle: no dev-server dependency discovery mid-run.
        command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 600_000,
      },
});
