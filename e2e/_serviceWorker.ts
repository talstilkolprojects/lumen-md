import { test } from "@playwright/test";

/**
 * The service worker in the e2e browsers (plan 0.5, W4.12): it exists on the
 * production build only (the dev server registers none), and Playwright can
 * take only Chromium offline with a worker in control. One helper for that
 * gap, so the specs that need the worker (pwa, pwa-offline, live-exec) share
 * one skip.
 */
export function productionWorkerOrSkip(dev: boolean, browserName: string, { chromiumOnly }: { chromiumOnly: boolean }): void {
  // skip-reason: the service worker exists on the production build only, and Playwright can take only Chromium offline with a worker in control | task: 0.5 | until: 2027-05-12
  test.skip(dev || (chromiumOnly && browserName !== "chromium"), chromiumOnly ? "the service-worker offline checks run on the production build in Chromium" : "the service worker runs on the production build only");
}
