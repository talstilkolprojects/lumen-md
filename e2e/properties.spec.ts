import { test, expect } from "@playwright/test";

/**
 * Properties editor (plan 4.9): open it from the command palette, edit a
 * value, toggle a checkbox and add a property — the editor's text changes
 * in exactly those places, comments and the body stay. In Hebrew UI the
 * panel sits on the left (inline-end).
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

const NOTE = "---\n# keep this comment\ntitle: 'Draft'\ndone: false\n---\n\n# Body\n";

async function openProperties(page: import("@playwright/test").Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.locator('[role="dialog"]').filter({ has: page.locator("input") });
  await expect(palette).toBeVisible();
  await palette.locator("input").first().fill("properties");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Properties/i);
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("properties-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("editing properties changes only those values in the note", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill(NOTE);

  const panel = await openProperties(page);
  const title = panel.getByLabel("Value of title");
  await expect(title).toHaveValue("Draft");
  await title.fill("Final");
  await title.press("Enter");
  await panel.getByLabel("Value of done").check();
  await panel.getByLabel("Property name").fill("status");
  await panel.getByLabel("Add property").click();

  await expect(editor).toContainText("title: 'Final'");
  const text = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".cm-content .cm-line")).map((l) => l.textContent ?? "").join("\n"),
  );
  expect(text).toBe("---\n# keep this comment\ntitle: 'Final'\ndone: true\nstatus:\n---\n\n# Body\n".replace(/\n$/, "\n"));
});

test("the panel is on the inline-end side in a right-to-left UI", async ({ page }) => {
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  const panel = await openProperties(page);
  const box = await panel.boundingBox();
  expect(box?.x).toBeLessThan(10);
});
