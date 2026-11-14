import { test } from "@playwright/test";

/**
 * Engine gaps shared by several specs (plan W4.12): one helper per gap, so
 * e2e/ keeps under its skip cap (scripts/lib/skipAudit.mjs) and each gap is
 * written down once.
 */

/** What only Playwright's Chromium can do: a CDP call, a command-line flag, or an API Firefox and WebKit lack. */
export type ChromiumOnly = "page.pdf()" | "CPU throttling" | "the mDNS flag";

/** Skip on every engine but Chromium, for a Playwright capability only Chromium has. */
export function chromiumOnly(browserName: string, what: ChromiumOnly): void {
  // skip-reason: a Playwright capability only its Chromium has — page.pdf(), CDP CPU throttling, Chromium's flag that shows LAN addresses (mDNS host candidates); Firefox and WebKit have no equivalent in Playwright | task: W4.12 | until: 2027-05-12
  test.skip(browserName !== "chromium", `${what}: Playwright has it in Chromium only`);
}

/** The service-worker offline checks: the production build only, and only Chromium can go offline with a worker in control. */
export function swOfflineOrSkip(dev: boolean, browserName: string, what: string): void {
  // skip-reason: the service worker exists on the production build only, and Playwright can take only Chromium offline with a worker in control | task: 0.5 | until: 2027-05-12
  test.skip(dev || browserName !== "chromium", what);
}
