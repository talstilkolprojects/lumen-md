import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W4.21 — the accessibility tree of the key Hebrew flows, pinned with
 * Playwright's aria snapshots (`toMatchAriaSnapshot`). What a screen reader
 * gets — roles, names, states — in the Hebrew interface: the skip link and
 * the main landmark, the command palette (dialog, combobox-style search,
 * results as options), the keyboard-shortcuts dialog, and a Hebrew note's
 * structure in the preview (heading levels, list, task state, link).
 *
 * Templates are partial by design (`/children: contains` is Playwright's
 * default): they list what must be there, in order, and allow the rest.
 * Real screen-reader output (VoiceOver, NVDA) is sr/, run by Guidepup on a
 * Mac or Windows host (docs: editor/screen-reader-automation).
 */

const NOTE = ["# תוכנית", "", "פסקה בעברית עם English באמצע.", "", "## משימות", "", "- [ ] לקנות חלב", "- [x] לשלם חשבון", "", "[קישור לאתר](https://example.com)", ""].join("\n");

async function open(page: Page, mode: "preview" | "source" = "preview") {
  await page.addInitScript(
    ({ content, mode }) => {
      localStorage.clear();
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he", mode, doc: { name: "תוכנית.md", content, dirty: false, workspaceName: null } }, version: 0 }));
    },
    { content: NOTE, mode },
  );
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

test.describe("aria snapshots, Hebrew interface", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "the accessibility tree is pinned on Chromium; the real readers are in sr/");

  test("shell: the skip link comes first, then the main landmark", async ({ page }) => {
    await open(page);
    await expect(page.locator("body")).toMatchAriaSnapshot(`
      - link "דילוג לתוכן הראשי"
      - main
    `);
  });

  test("preview: heading levels, the task list with its states, the link", async ({ page }) => {
    await open(page, "preview");
    const preview = page.locator(".prose-lumen").first();
    await expect(preview.locator("h1")).toContainText("תוכנית", { timeout: 15_000 });
    await expect(preview).toMatchAriaSnapshot(`
      - heading "תוכנית" [level=1]
      - paragraph: /פסקה בעברית/
      - heading "משימות" [level=2]
      - list:
        - listitem:
          - checkbox [checked=false]
        - listitem:
          - checkbox [checked=true]
      - paragraph:
        - link "קישור לאתר"
    `);
  });

  test("command palette: a named modal dialog with a search box and results as options", async ({ page }) => {
    await open(page);
    await expect(page.locator(".prose-lumen h1").first()).toContainText("תוכנית", { timeout: 15_000 });
    await page.getByRole("button", { name: "פלטת פקודות" }).first().click();
    const dialog = page.getByRole("dialog", { name: "הקלד פקודה, או חפש…" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toMatchAriaSnapshot(`
      - textbox "הקלד פקודה, או חפש…"
      - listbox "הקלד פקודה, או חפש…":
        - option
    `);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("keyboard shortcuts: a named modal dialog with a heading", async ({ page }) => {
    await open(page);
    await expect(page.locator(".prose-lumen h1").first()).toContainText("תוכנית", { timeout: 15_000 });
    // Ctrl+/ toggles the shortcuts dialog (App.tsx accepts Ctrl or ⌘).
    await page.keyboard.press("Control+/");
    const dialog = page.getByRole("dialog", { name: "קיצורי מקלדת" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toMatchAriaSnapshot(`
      - heading [level=2]
    `);
  });
});
