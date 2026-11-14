import { test, expect } from "@playwright/test";

/**
 * Smoke tests — lightweight checks that the app boots, renders the toolbar,
 * and core keyboard shortcuts work. Each test runs in its own page so state
 * doesn't bleed between assertions.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Skip the onboarding tour and persisted doc so tests start from a known
    // state. Set before navigation so the first render uses the cleared store.
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  // React mounts asynchronously; window keydown listeners (⌘K, ⌘1..⌘4) attach
  // inside a useEffect so we must wait for the toolbar before firing keys.
  await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
});

test("loads the editor shell", async ({ page }) => {
  // The 5 menu buttons (File / Edit / Insert / View Mode / Help) are always
  // visible. The right side intentionally has no ⌘K shortcut.
  await expect(page.locator("header button:has-text('File')")).toBeVisible();
  await expect(page.locator("header button:has-text('Edit')")).toBeVisible();
  await expect(page.locator("header button:has-text('Insert')")).toBeVisible();
  await expect(page.locator("header button:has-text('View Mode')")).toBeVisible();
  await expect(page.locator("header button:has-text('Help')")).toBeVisible();
});

test("opens the command palette via ⌘K and closes via Escape", async ({ page }) => {
  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("File menu exposes core sections (Documents / Export / Workspace)", async ({ page }) => {
  await page.locator("header button:has-text('File')").click();
  const menu = page.getByRole("menu").first();
  // Section headers are uppercased via CSS. Match the underlying text exactly
  // so Playwright doesn't pick up similar substrings inside the menu items.
  await expect(menu.getByText("Documents", { exact: true })).toBeVisible();
  await expect(menu.getByText("Export", { exact: true })).toBeVisible();
  await expect(menu.getByText("Workspace", { exact: true })).toBeVisible();
  // The "Show Welcome.md" pill is the bottom-of-menu surfacing of the
  // bundled tour document, added in the Welcome-restore feature.
  await expect(menu.getByRole("menuitem", { name: /Welcome\.md/ })).toBeVisible();
});

test("Insert menu leads with the Smart Insert dialog", async ({ page }) => {
  await page.locator("header button:has-text('Insert')").click();
  const menu = page.getByRole("menu").first();
  // "Insert anything…" is the headline entry — auto-detect dialog (⌘⇧V).
  await expect(menu.getByRole("menuitem", { name: /Insert anything/ })).toBeVisible();
  await expect(menu.getByText(/specific block/i)).toBeVisible();
});

test("Insert menu shows nested categories with chevrons", async ({ page }) => {
  await page.locator("header button:has-text('Insert')").click();
  const menu = page.getByRole("menu").first();
  await expect(menu.getByText("Tables & Charts")).toBeVisible();
  await expect(menu.getByText("Diagrams")).toBeVisible();
  await expect(menu.getByText("Media")).toBeVisible();
  await expect(menu.getByText("Math & References")).toBeVisible();

  // Hovering Diagrams reveals its child popout containing Mermaid.
  await menu.getByText("Diagrams").hover();
  await expect(page.getByRole("menuitem", { name: /Insert diagram \(Mermaid\)/i })).toBeVisible();
});

test("⌘1..⌘4 cycle through the four view modes", async ({ page }) => {
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator("[data-preview-root]")).toHaveCount(0);

  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator("[data-preview-root]")).toBeVisible();

  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  await expect(page.locator("[data-preview-root]")).toBeVisible();

  await page.keyboard.press("Meta+4");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 8_000 });
});

test("locale switch flips html dir and translates menu labels", async ({ page }) => {
  // Click the Menu pill in the top-left to open the palette — robust to
  // editor focus stealing the ⌘K keystroke on different platforms.
  await page.locator("button:has-text('Menu')").click();
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible({ timeout: 5_000 });
  await palette.getByRole("textbox").fill("Language: עברית");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/עברית/, { timeout: 5000 });
  await page.keyboard.press("Enter");

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("header button:has-text('קובץ')")).toBeVisible();
  await expect(page.locator("header button:has-text('עזרה')")).toBeVisible();
});

test("outline shows headings (frontmatter is hidden)", async ({ page }) => {
  // Outline is built from the welcome doc which has YAML frontmatter; the
  // first link must be 'Welcome to Lumen', not 'title: …'.
  const aside = page.locator("aside.outline-aside");
  await expect(aside.locator("a").first()).toHaveText(/Welcome to Lumen/);
  await expect(aside.locator("a", { hasText: /^title:/ })).toHaveCount(0);
});

test("preview renders markdown blocks (headings, code, math, table)", async ({ page }) => {
  // Wait for renderer to populate
  const preview = page.locator("[data-preview-root]");
  await expect(preview.locator("h1")).toBeVisible({ timeout: 10_000 });
  await expect(preview.locator("pre code").first()).toBeVisible();
  await expect(preview.locator(".katex").first()).toBeVisible();
  await expect(preview.locator("table").first()).toBeVisible();
});
