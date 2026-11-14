import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.visual.config";

/**
 * Percy (plan W7.25): the visual harness's app server and settings, but the
 * *.percy.ts snapshots, one Chromium that captures the DOM (Percy renders it
 * in Chrome, Firefox, Safari and Edge itself), and no local comparisons.
 *   npm run visual:percy                 # PERCY_TOKEN in the agent's secret store
 *   LUMEN_PERCY_CANARY=1 npm run visual:percy   # the 2px RTL self-test, a build never approved
 */
export default defineConfig({
  ...base,
  testMatch: /.*\.percy\.ts$/,
  reporter: [["list"]],
  projects: [{ name: "percy-capture", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } }],
});
