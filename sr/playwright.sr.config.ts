/**
 * Plan W4.21 — Playwright config for the real screen readers (Guidepup).
 * Not part of `npm run test:e2e`: it needs a Mac (VoiceOver) or Windows
 * (NVDA) with the reader set up by `npx @guidepup/setup`, and it takes over
 * the machine's audio and keyboard while it runs. One worker, no retries:
 * a screen reader is a single shared resource.
 *
 *   npm run test:sr -- --project=voiceover     # macOS
 *   npm run test:sr -- --project=nvda-chrome   # Windows
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 4317;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.sr\.ts$/,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: "../sr-results/results.json" }]],
  use: { baseURL: `http://localhost:${PORT}/`, headless: false, video: "off" },
  webServer: { command: `npm run build && npx vite preview --port ${PORT} --strictPort`, url: `http://localhost:${PORT}/`, reuseExistingServer: true, timeout: 300_000, cwd: ".." },
  projects: [
    { name: "voiceover", testMatch: /voiceover\.sr\.ts$/, use: { ...devices["Desktop Safari"], headless: false } },
    { name: "nvda-chrome", testMatch: /nvda\.sr\.ts$/, use: { ...devices["Desktop Chrome"], channel: "chrome", headless: false } },
    { name: "nvda-firefox", testMatch: /nvda\.sr\.ts$/, use: { ...devices["Desktop Firefox"], headless: false } },
  ],
});
