import { defineConfig, devices } from "@playwright/test";

/**
 * The docs GIF recorder (plan W4.34): `npm run docs:gifs` records the 30
 * flows of e2e/gifs/flows.ts in Hebrew into docs/public/gifs/. Not part of
 * the e2e suite (its files are *.gifs.ts, which the main config does not
 * match). Same dev server as playwright.config.ts.
 */
const PORT = 5173;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e/gifs",
  testMatch: /.*\.gifs\.ts$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 1,
    locale: "he-IL",
    colorScheme: "light",
  },
  projects: [{ name: "gifs-chromium" }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : { command: "npm run dev", url: BASE_URL, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
