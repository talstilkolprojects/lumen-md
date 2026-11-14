import { test, expect } from "@playwright/test";

/**
 * 14.2 — feedback without a server: the form makes no request and opens
 * nothing until the user clicks; "Open on GitHub" opens github.com's issue
 * form with exactly the previewed text (github.com is stubbed here).
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("feedback: nothing leaves before the click, then GitHub opens with the previewed issue", async ({ page, context }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const external: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin !== new URL(page.url()).origin && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) external.push(req.url());
  });
  await context.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>stub</title>" }));

  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Send feedback");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/feedback/i, { timeout: 8000 });
  await page.keyboard.press("Enter");

  const dialog = page.getByTestId("feedback-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId("feedback-open-github")).toBeDisabled();
  await dialog.getByTestId("feedback-title").fill("הכרטיסיות נעלמות");
  await dialog.getByTestId("feedback-description").fill("Closed one tab, all of them went.");
  await expect(dialog.getByTestId("feedback-preview")).toContainText("Bug: הכרטיסיות נעלמות");
  await expect(dialog.getByTestId("feedback-preview")).toContainText("## Environment");
  // The doctor report stays out until ticked.
  await expect(dialog.getByTestId("feedback-preview")).not.toContainText("## AI doctor report");
  expect(external).toEqual([]);

  const preview = (await dialog.getByTestId("feedback-preview").textContent()) ?? "";
  const popupPromise = page.waitForEvent("popup");
  await dialog.getByTestId("feedback-open-github").click();
  const popup = await popupPromise;
  const u = new URL(popup.url());
  expect(`${u.origin}${u.pathname}`).toBe("https://github.com/talstilkol/lumen-md/issues/new");
  expect(`${u.searchParams.get("title")}\n\n${u.searchParams.get("body")}`).toBe(preview);
  await expect(dialog.getByTestId("feedback-notice")).toBeVisible();
  // The only outside request is the user's own navigation to github.com, in the new tab.
  expect(external).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 5000 });
  expect(pageErrors).toEqual([]);
});
