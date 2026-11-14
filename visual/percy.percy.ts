/**
 * Plan W7.25: 30 screens × he / en × light / dark, as Percy snapshots. Run it
 * with `npm run visual:percy` (inside `percy exec`); outside it every test is
 * skipped, so it never runs by accident. The local baselines (10.3) stay as
 * they are; Percy adds real Safari, Firefox and Edge.
 */
import { test } from "@playwright/test";
import { RTL_NOTE } from "../e2e/rtl-note";
import { SURFACES, VARIANTS, prepare, settle } from "./harness";
import { percyEnabled, percySnapshot } from "./percy";
import { RTL_CANARY_CSS, domSettled, percySurfaces } from "./percy-surfaces";

const PERCY_SURFACES = percySurfaces(SURFACES);

const canary = process.env.LUMEN_PERCY_CANARY === "1";

test.beforeAll(async () => {
  test.skip(!(await percyEnabled()), "not inside `percy exec`");
});

for (const v of VARIANTS) {
  test.describe(v.id, () => {
    for (const s of PERCY_SURFACES) {
      test(s.id, async ({ page }) => {
        await prepare(page, v, s.id === "rtl-matrix" ? RTL_NOTE : undefined);
        await s.open(page);
        await page.locator(s.ready).first().waitFor({ state: "visible", timeout: 20_000 });
        if (s.ready === "body") await domSettled(page);
        await s.settled?.(page);
        await settle(page);
        const ok = await percySnapshot(page, `${s.id} — ${v.id}`, { widths: [1280], minHeight: 800, ...(canary ? { percyCSS: RTL_CANARY_CSS } : {}) });
        test.skip(!ok, "Percy server went away");
      });
    }
  });
}
