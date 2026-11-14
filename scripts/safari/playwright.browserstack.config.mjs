// Playwright config for the Safari run on BrowserStack (plan W6.6).
// scripts/safari/run.mjs copies it to .factory/ in the checkout under test,
// so `@playwright/test` resolves from that checkout's node_modules. The
// BrowserStack Node SDK reads browserstack.yml (same folder as the command)
// and runs every spec once per platform there; BrowserStack Local tunnels
// localhost to the devices, so the app is served from this machine.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.LUMEN_SAFARI_PORT ?? 4190);
const DIST = process.env.LUMEN_SAFARI_DIST ?? ".factory/dist-safari";

export default defineConfig({
  testDir: "../e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  webServer: {
    command: `npx vite preview --outDir ${DIST} --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
