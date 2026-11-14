#!/usr/bin/env node
/**
 * The e2e gate (W1.1): Playwright on chromium against the production build
 * (`vite preview` of dist/), inside the Vercel preview build, after vitest.
 *
 * The Vercel build image is Amazon Linux 2023, as root, with dnf. Playwright's
 * Ubuntu headless shell needs only nss and nspr from it. Browsers go into
 * node_modules (PLAYWRIGHT_BROWSERS_PATH=0), so the build cache keeps them.
 * Firefox runs there too, with no system libraries added: the gate runs
 * LUMEN_E2E_FIREFOX_SPECS on it (default the smoke spec). WebKit cannot run
 * on this image: Playwright's WebKit build needs glibc 2.38 (Amazon Linux
 * 2023 has 2.34) and libraries AL2023 does not package (libwpe,
 * wpebackend-fdo). Safari coverage is owed to a Mac (plan W4.22).
 *
 * What runs: LUMEN_E2E_SPECS (space-separated), by default the curated fast
 * set E2E_FAST of scripts/test-tiers.mjs (about 50 tests, about 5 min),
 * which keeps the smoke spec and, since W6.30, the Hebrew accessibility
 * pair: axe on the key Hebrew flows, light and dark (a11y-hebrew-gate), and
 * the Hebrew aria snapshots (aria-hebrew, W4.21). The whole chromium project
 * does not fit: on the build machine (2 CPUs, 2 workers) it took 29.7 min
 * for 327 tests (verify/e2e-probe run 4: 291 passed, 32 failed, 4 skipped).
 * Every spec runs nightly instead, in shards on three browsers
 * (scripts/nightly/plan.mjs); a spec joins the fast set once it passes there.
 *
 * The run is time-boxed (LUMEN_E2E_MINUTES, default 10, and never past
 * minute GATE_BUDGET_MIN = 38 of the build). A box that runs out fails the
 * gate: it means the specs no longer fit, not that they passed.
 *
 * Specs that drive the app's modules from inside the page load them through
 * window.__lumenTest (e2e/_lumen.ts), which a build has only when made with
 * VITE_E2E=1; scripts/vercel-build.mjs sets it whenever the e2e gate runs.
 *
 *   VITE_E2E=1 npm run build && node scripts/e2e-gate.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_FAST, E2E_FIREFOX_FAST, GATE_BUDGET_MIN } from "./test-tiers.mjs";

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
export const E2E_MINUTES = Number(process.env.LUMEN_E2E_MINUTES ?? 10);
const list = (v, fallback) => (v ?? fallback.join(" ")).split(/\s+/).filter(Boolean);
export const E2E_SPECS = list(process.env.LUMEN_E2E_SPECS, E2E_FAST);
/** Firefox runs too (LUMEN_E2E_FIREFOX_SPECS, default the smoke spec; empty turns it off). */
export const FIREFOX_SPECS = list(process.env.LUMEN_E2E_FIREFOX_SPECS, E2E_FIREFOX_FAST);
/** What the gate runs, in order: each project with its specs. */
export function e2eRuns(chromium = E2E_SPECS, firefox = FIREFOX_SPECS) {
  return [
    { project: "chromium", install: ["--only-shell", "chromium"], specs: chromium },
    { project: "firefox", install: ["firefox"], specs: firefox },
  ].filter((r) => r.specs.length > 0);
}
/**
 * Vercel stops a build at 45 minutes. scripts/vercel-build.mjs sets
 * LUMEN_BUILD_STARTED; the box ends by minute GATE_BUDGET_MIN (38) of the
 * build, so the gates after this one still get their 7 minutes.
 */
export function boxMinutes(env = process.env, now = Date.now()) {
  const started = Number(env.LUMEN_BUILD_STARTED);
  const left = Number.isFinite(started) && started > 0 ? GATE_BUDGET_MIN - (now - started) / 60_000 : Infinity;
  return Math.max(0, Math.floor(Math.min(E2E_MINUTES, left)));
}

const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0", PLAYWRIGHT_BASE_URL: BASE };
const log = (s) => console.log(`[e2e] ${s}`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function main() {
  if (!existsSync("dist/index.html")) {
    console.error("[e2e] no dist/: run the build first");
    process.exit(1);
  }
  // nss / nspr for the headless shell, when the image lets us install them (root + dnf).
  if (process.getuid?.() === 0 && spawnSync("sh", ["-c", "command -v dnf"]).status === 0) {
    const r = spawnSync("dnf", ["-y", "-q", "install", "nss", "nspr"], { stdio: "inherit" });
    log(`dnf install nss nspr: exit ${r.status}`);
  }
  const runs = e2eRuns();
  for (const run of runs) {
    if (spawnSync(npx, ["playwright", "install", ...run.install], { stdio: "inherit", env }).status !== 0) {
      console.error(`[e2e] could not install ${run.project}`);
      process.exit(1);
    }
  }
  const preview = spawn(npx, ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { env, stdio: ["ignore", "inherit", "inherit"] });
  const stop = () => preview.kill();
  const deadline = Date.now() + 60_000;
  const wait = () =>
    fetch(`${BASE}/`).then(
      (r) => r.ok,
      () => false,
    );
  (async () => {
    while (!(await wait())) {
      if (Date.now() > deadline) {
        stop();
        console.error("[e2e] vite preview did not answer within 60 s");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // One box for the whole gate, shared by the runs in order.
    const gateEnd = Date.now() + boxMinutes() * 60_000;
    let failed = 0;
    for (const run of runs) {
      const box = Math.floor((gateEnd - Date.now()) / 60_000);
      if (box < 3) {
        console.error(`[e2e] ${run.project}: only ${box} min left in the gate's box: the specs no longer fit`);
        failed++;
        continue;
      }
      log(`${run.project}: ${run.specs.join(" ")} against ${BASE}, time box ${box} min`);
      const report = env.LUMEN_E2E_REPORT_FILE?.replace(/(\.[a-z]+)?$/, `-${run.project}$1`);
      const r = spawnSync(
        npx,
        ["playwright", "test", ...run.specs, `--project=${run.project}`, "--workers=2", "--reporter=line,./scripts/e2e-report.mjs", `--global-timeout=${box * 60_000}`],
        { stdio: "inherit", env: { ...env, ...(report ? { LUMEN_E2E_REPORT_FILE: report } : {}) }, timeout: (box + 3) * 60_000 },
      );
      log(`${run.project}: exit ${r.status ?? r.signal}`);
      if (r.status !== 0) failed++;
    }
    stop();
    process.exit(failed ? 1 : 0);
  })();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
