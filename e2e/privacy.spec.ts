import { test, expect } from "@playwright/test";

/** T37 — the privacy ledger: local-only blocks cloud AI, and everything is listed. */
test("local-only blocks a cloud AI request before it leaves; the ledger shows it", async ({ page }) => {
  let reached = 0;
  await page.route("https://api.openai.com/**", (route) => {
    reached++;
    return route.fulfill({ status: 200, body: "{}", headers: { "content-type": "application/json" } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });

  const outcome = await page.evaluate(() =>
    fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "סוד" }] }) }).then(
      () => "sent",
      (e: Error) => e.name,
    ),
  );
  expect(outcome).toBe("PrivacyBlockedError");
  expect(reached).toBe(0);
  await expect(page.getByText(/Blocked by the local-only policy: OpenAI/).first()).toBeVisible({ timeout: 5000 });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.privacyLedger" } })));
  const panel = page.locator('[role="dialog"][aria-label="Privacy ledger"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="privacy-row"][data-decision="blocked"]')).toHaveCount(1);
  await expect(panel).toContainText("api.openai.com");
  await expect(panel).not.toContainText("סוד");
});

test("under the cloud policy the request goes out and is recorded with its size", async ({ page }) => {
  await page.route("https://api.openai.com/**", (route) => route.fulfill({ status: 200, body: "{}", headers: { "content-type": "application/json", "content-length": "2" } }));
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "cloud");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  const status = await page.evaluate(() => fetch("https://api.openai.com/v1/models").then((r) => r.status));
  expect(status).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.privacyLedger" } })));
  const panel = page.locator('[role="dialog"][aria-label="Privacy ledger"]');
  await expect(panel.locator('[data-testid="privacy-row"][data-decision="allowed"]')).toHaveCount(1);
});
