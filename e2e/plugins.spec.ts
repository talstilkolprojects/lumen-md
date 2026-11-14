import { test, expect, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Plan 11.2 acceptance: "`e2e/plugins.spec.ts`: 3 plugins run". Three of the
 * example plugins in public/plugins/examples/ are installed from the Plugin
 * Gallery (scan, permission screen, "Install and allow") and then used the
 * way a person uses them, each through a different part of the API:
 *
 *   word-stats  a palette command that opens a side panel (document:read, panel, settings)
 *   callout     a code-block renderer, in the preview (renderer, storage)
 *   toc         a palette command that writes into the note (document:read, document:write)
 *
 * They run in the QuickJS sandbox in a worker; nothing they do may leave the
 * page's origin. Per-channel exfiltration is covered by
 * src/__tests__/pluginsExfiltration.test.ts (one test per channel).
 */

const EXAMPLES = path.join(process.cwd(), "public", "plugins", "examples");
const manifestOf = (dir: string) => JSON.parse(readFileSync(path.join(EXAMPLES, dir, "lumen-plugin.json"), "utf8")) as { id: string; name: string };
const WORD_STATS = manifestOf("word-stats");
const CALLOUT = manifestOf("callout");
const TOC = manifestOf("toc");

const NOTE = [
  "# Plan",
  "",
  "A short note about the plan, with enough words to count.",
  "",
  "## שלב א",
  "",
  "טקסט בעברית לשלב הראשון.",
  "",
  "## Step two",
  "",
  "```callout",
  "Before the release",
  "- [ ] Write the notes",
  "- [x] Run the tests",
  "See [[Plan]] for the rest.",
  "```",
  "",
].join("\n");

type View = { state: { doc: { length: number; toString(): string } }; dispatch(tr: unknown): void; focus(): void };

/** Replace the open note's text in the source editor (as e2e/obsidian-syntax.spec.ts does). */
async function load(page: Page, text: string): Promise<void> {
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.evaluate((t) => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    // The cursor ends up after the text: a plugin's insert goes there.
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: t.length }, userEvent: "input" });
  }, text);
  await expect.poll(() => source(page)).toBe(text);
}

function source(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    return el?.cmTile?.root?.view?.state.doc.toString() ?? "";
  });
}

async function palette(page: Page, query: string, expected: RegExp | string): Promise<void> {
  await page.keyboard.press("Meta+K");
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await dialog.waitFor({ timeout: 8000 });
  await dialog.locator("input").first().fill(query);
  await expect(dialog.locator('[role="option"][aria-selected="true"]')).toContainText(expected, { timeout: 8000 });
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
}

/** Gallery → card → permission screen → "Install and allow"; the plugin is running when the toast says so. */
async function install(page: Page, m: { id: string; name: string }): Promise<void> {
  const gallery = page.locator('[role="dialog"][aria-labelledby="plugin-gallery-title"]');
  const card = gallery.getByTestId("sandboxed-plugins").locator(`[data-testid="sandboxed-plugin-card"][data-plugin="${m.id}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /Install/ }).click();
  const dialog = page.getByTestId("plugin-install-dialog");
  await expect(dialog.getByRole("heading")).toContainText(m.name);
  await dialog.getByRole("button", { name: "Install and allow" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(`“${m.name}” is installed.`)).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 20_000 });
});

test("three example plugins run: a panel command, a code-block renderer and a command that writes", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost").origin;
  const offOrigin: string[] = [];
  page.on("request", (r: Request) => {
    const u = r.url();
    if (/^(data|blob|about):/.test(u)) return;
    try {
      if (new URL(u).origin === origin) return;
    } catch {
      /* not a URL: report it */
    }
    offOrigin.push(`${r.method()} ${u}`);
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await palette(page, "Plugin Gallery", /Plugin Gallery/i);
  const gallery = page.locator('[role="dialog"][aria-labelledby="plugin-gallery-title"]');
  await expect(gallery).toBeVisible();
  for (const m of [WORD_STATS, CALLOUT, TOC]) await install(page, m);
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden();
  // The note is written after the install, so the preview meets the callout language already registered.
  await load(page, NOTE);

  // 1. word-stats: its command is in the palette under the plugin's name, and opens its panel.
  await palette(page, "Word stats", `Word stats · ${WORD_STATS.name}`);
  const panel = page.locator(`aside[data-plugin-panel="${WORD_STATS.id}"]`);
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText("Word stats");
  await expect(panel).toContainText(/Words: [1-9]\d*/);
  await expect(panel).toContainText(/Reading time: \d+ min at 200 words\/min/);
  // A setting through the panel: the plugin stores it and renders again.
  await panel.locator("select").selectOption("300");
  await expect(panel).toContainText("at 300 words/min", { timeout: 10_000 });
  await panel.getByRole("button", { name: "Close the plugin panel" }).click();
  await expect(panel).toBeHidden();

  // 2. callout: the ```callout block in the preview is the plugin's UI tree, not code.
  await page.keyboard.press("Meta+3");
  const block = page.locator(`[data-preview-root] [data-plugin-block="callout"][data-plugin-id="${CALLOUT.id}"]`).first();
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block.getByRole("heading", { name: "Before the release" })).toBeVisible();
  const boxes = block.getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  // [[Plan]] is a note link (a button), never an <a href>.
  await expect(block.getByRole("button", { name: "Plan" })).toBeVisible();
  await expect(block.locator("a, img, iframe, form, style, script")).toHaveCount(0);
  // Ticking a box is a UI event to the plugin (it keeps it in its own storage); the box stays ticked across a view switch.
  await boxes.nth(0).check();
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("Meta+3");
  await expect(page.locator(`[data-preview-root] [data-plugin-block="callout"]`).first().getByRole("checkbox").nth(0)).toBeChecked({ timeout: 15_000 });

  // 3. toc: its command writes a table of contents of the headings into the note.
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await palette(page, "Insert table of contents", `Insert table of contents · ${TOC.name}`);
  await expect.poll(() => source(page), { timeout: 10_000 }).toContain("- [[#Plan|Plan]]");
  const text = await source(page);
  expect(text).toContain("  - [[#שלב א|שלב א]]");
  expect(text).toContain("  - [[#Step two|Step two]]");
  // The table is added; nothing of the note is lost.
  expect(text).toContain(NOTE.trim());

  expect(offOrigin, "requests that left the page's origin").toEqual([]);
  expect(pageErrors).toEqual([]);
});
