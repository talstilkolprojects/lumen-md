import type { Page } from "@playwright/test";
import type { LumenTestHooks } from "../src/testing/e2eHooks";

/**
 * The app's own modules inside the page (W4.2): `window.__lumenTest.load(name)`
 * (src/testing/e2eHooks.ts) instead of a dynamic import of a /src/ path,
 * which only the dev server answers. It works on the dev server and on a build made with
 * VITE_E2E=1, the build the e2e gate serves. In a page.evaluate:
 *
 *   const ws = await (window as unknown as LumenTestWindow).__lumenTest.load("storage/workspace");
 */
export type LumenTestWindow = Window & { __lumenTest: LumenTestHooks };

/** Wait until the app has installed window.__lumenTest (it does so just after start-up). */
export async function testHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => "__lumenTest" in window, null, { timeout: 15_000 });
}
