import { test, expect, type Request } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- plain ESM script module, no types
import { verifyBundle } from "../scripts/privacy/report-core.mjs";
// @ts-expect-error -- plain ESM script module, no types
import { compareWithReport } from "../scripts/privacy/compare.mjs";

/**
 * Plan W2.24, audit mode: the whole journey under the local-only policy, with
 * the ledger in audit mode (it lists every request that leaves the device,
 * not only AI), then the signed report exported from the ledger panel.
 *
 *   - the report verifies (signature, shape, its summary) and says 0
 *     requests left the device;
 *   - Playwright's own request log, an observer outside the app, agrees
 *     with it: 0 non-local requests on the wire, and nothing the report
 *     misses;
 *   - run by scripts/privacy/audit.mjs, the browser also goes through
 *     mitmproxy (LUMEN_AUDIT_PROXY), and the script compares its capture with
 *     the report the same way. LUMEN_AUDIT_OUT is where the report and the
 *     request log are left for it.
 *
 * Cloud providers are configured with keys, to tempt every fallback.
 */
const proxy = process.env.LUMEN_AUDIT_PROXY;
if (proxy) test.use({ proxy: { server: proxy, bypass: "<-loopback>" }, ignoreHTTPSErrors: true });

const run = (page: import("@playwright/test").Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** The journey: the app's own views and exports, and the AI commands that would use the configured cloud provider. */
const JOURNEY = ["view.source", "view.split", "view.preview", "view.wysiwyg", "view.outline", "view.source", "view.backlinks", "ai.diagram", "ai.actionItems", "ai.chart", "file.exportHtml"];

test("audit mode: the local-only journey, the signed report and the request log agree on 0 non-local requests", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const out = process.env.LUMEN_AUDIT_OUT ?? testInfo.outputPath("audit");
  mkdirSync(out, { recursive: true });
  const seen: string[] = [];
  page.on("request", (r: Request) => seen.push(r.url()));

  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem("lumen.privacy.audit", "1");
    localStorage.setItem("lumen.ai.provider", "anthropic");
    for (const p of ["openai", "anthropic", "gemini", "mistral"]) localStorage.setItem(`lumen.ai.key.${p}`, "test-key");
  });
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("Welcome to", { timeout: 15_000 });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n# ביקורת פרטיות\n\nA note for the privacy audit, with a list:\n\n- [ ] משימה ראשונה\n- [ ] second task\n");

  const modal = page.locator('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
  const settle = async () => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(async () => {
      if ((await modal.count()) > 0) await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
  };
  for (const id of JOURNEY) {
    await run(page, id);
    await settle();
  }
  // A cloud request by hand: the ledger blocks it before it leaves (it is listed, blocked).
  const outcome = await page.evaluate(() =>
    fetch("https://api.openai.com/v1/models").then(
      () => "sent",
      (e: Error) => e.name,
    ),
  );
  expect(outcome).toBe("PrivacyBlockedError");

  // Export the signed report from the ledger panel.
  await run(page, "ai.privacyLedger");
  const panel = page.locator('[role="dialog"][aria-label="Privacy ledger"]');
  await expect(panel).toBeVisible({ timeout: 5000 });
  await expect(panel.getByTestId("privacy-audit-mode")).toBeVisible();
  const download = page.waitForEvent("download");
  await panel.getByTestId("privacy-export").click();
  const file = join(out, "report.json");
  await (await download).saveAs(file);
  await expect(panel.getByRole("status")).toContainText(/left this device/);
  writeFileSync(join(out, "requests.json"), JSON.stringify(seen, null, 2));

  const bundle = JSON.parse(readFileSync(file, "utf8"));
  const v = verifyBundle(bundle, { localOnly: true });
  expect(v.problems).toEqual([]);
  expect(v.report.auditMode).toBe(true);
  expect(v.report.summary.blocked).toBeGreaterThan(0); // the hand-made cloud request is in it
  const c = compareWithReport("playwright", seen, v.report);
  expect(c.requestsSeen).toBeGreaterThan(0);
  expect(c.observedNonLocal).toEqual([]);
  expect(c.unlogged).toEqual([]);
  expect(c.unseen).toEqual([]);
});
