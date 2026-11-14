import { test, expect } from "@playwright/test";
import { registerLumenStateReset } from "./_clear-state";

/**
 * Error-path e2e — systematically poke things that fail gracefully
 * to find places where they don't. Each test captures pageerror
 * events and asserts none fire (or asserts the expected user-facing
 * error UI appears).
 *
 * Focused on paths a real user can hit without external services:
 * malformed fence content, broken markdown structures, oversized
 * inputs, rapid concurrent actions.
 */

function captureErrors(page: import("@playwright/test").Page): string[] {
  const errs: string[] = [];
  page.on("pageerror", (e) => {
    const m = e.message;
    // Filter sandboxed-iframe storage-access denials — these come from
    // dynamic-block iframes (HTML preview, live-js, embed) that mount with
    // `sandbox="allow-scripts"` and thus can't read the parent's
    // localStorage. They're environmental, not Lumen bugs. Three different
    // browser engines surface this as three slightly different strings, so
    // the filter unions them.
    if (
      /Storage is disabled inside 'data:'/i.test(m) ||
      /sandboxed and lacks the 'allow-same-origin'/i.test(m) ||
      /allow-scripts/i.test(m) ||
      /Failed to read the 'localStorage' property from 'Window': Access is denied/i.test(m) ||
      /Failed to read a named property 'localStorage' from 'Window'/i.test(m)
    ) {
      return;
    }
    errs.push(m);
  });
  return errs;
}

test.beforeEach(async ({ page }) => {
  // Deep reset: clears every "lumen-*" and "lumen.*" key, re-sets the
  // tour-done flag. Avoids OAuth tokens / collab signaling state from
  // leaking between runs. See e2e/_clear-state.ts.
  await registerLumenStateReset(page);
  await page.goto("/");
  await page
    .locator("header")
    .first()
    .waitFor({ state: "visible", timeout: 5000 });
});

test("malformed mermaid syntax shows error block, no pageerror", async ({
  page,
}) => {
  // Two 15 s render waits after the page load: more than the default 30 s
  // test budget on a cold runner, by construction.
  test.slow();
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "```mermaid\nnot-a-valid-syntax => zzz\nbroken!!! [not a graph]\n```\n",
  );
  // The block either renders or shows its own error view; never a page error.
  await expect(page.locator(".mermaid-block").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".mermaid-error").first()).toBeVisible({ timeout: 15_000 });
  expect(errs).toEqual([]);
});

test("malformed graphviz syntax doesn't crash the renderer", async ({
  page,
}) => {
  // Two 15 s render waits after the page load: more than the default 30 s
  // test budget on a cold runner, by construction.
  test.slow();
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("```dot\nnot { valid graphviz at all\n```\n");
  await expect(page.locator(".mermaid-block").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".mermaid-error").first()).toBeVisible({ timeout: 15_000 });
  expect(errs).toEqual([]);
});

test("massive CSV (1000 rows) renders without freezing", async ({ page }) => {
  // Two 15 s render waits after the page load: more than the default 30 s
  // test budget on a cold runner, by construction.
  test.slow();
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  const rows = Array.from({ length: 1000 }, (_, i) =>
    `${i},Row ${i},${Math.random().toFixed(4)},${["A", "B", "C", "D"][i % 4]}`,
  );
  await editor.fill(
    "```csv\nid,name,score,group\n" + rows.join("\n") + "\n```\n",
  );
  await expect(page.locator(".chart-block").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".chart-block table").first()).toBeVisible({ timeout: 15_000 });
  expect(errs).toEqual([]);
});

test("LiveJS with throw doesn't propagate up to pageerror", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "```live-js\nthrow new Error(\"intentional from user code\");\n```\n",
  );
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  // The live-js block catches the throw and shows its status; no
  // uncaught pageerror leaks.
  await expect(page.locator(".chart-block").first()).toContainText(/Runtime error|intentional from user code/i, { timeout: 15_000 });
  expect(errs).toEqual([]);
});

test("LiveJS with infinite loop is timed out (block status reflects it)", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "```live-js\nwhile (true) { /* user typo */ }\n```\n",
  );
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  // The worker has a hard timeout (~3-5s): the status flips to "Timed out".
  await expect(page.locator("text=/Timed out|Runtime error/i").first()).toBeVisible({
    timeout: 15_000,
  });
  expect(errs).toEqual([]);
});

test("Print command with window.print stubbed (no real print) doesn't crash", async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as unknown as { __openedPrint?: boolean }).__openedPrint = false;
    window.open = () => {
      (window as unknown as { __openedPrint?: boolean }).__openedPrint = true;
      return null;
    };
    window.print = () => {};
  });
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"][aria-modal="true"]')
    .filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Print");
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/Print/i, { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden({ timeout: 5000 });
  expect(errs).toEqual([]);
});

test("opening a malformed JSON file via paste produces a graceful state", async ({
  page,
}) => {
  const errs = captureErrors(page);
  // Split view: the renderer must actually see the block (in source-only
  // mode the old version of this test rendered nothing and proved nothing).
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  // Garbled JSON inside a json-table fence (the renderer attempts a
  // JSON.parse internally; should NOT crash if it fails).
  await editor.fill(
    "```json-table\n[ { bad json, no quotes }, { also: bad } ]\n```\n",
  );
  await expect(page.locator(".chart-block").first()).toContainText(/parse error/i, { timeout: 15_000 });
  expect(errs).toEqual([]);
});

test("typing a 5000-character heading line doesn't freeze the editor", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("# " + "long heading text ".repeat(280));
  await expect(editor).toContainText("long heading text long heading text");
  // Cursor should still be in the editor.
  await expect(editor).toBeVisible();
  expect(errs).toEqual([]);
});

test("rapid Cmd+S spam doesn't break the save pipeline", async ({ page }) => {
  // Stub save dialogs so we don't actually open them.
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = async () => {
      throw new DOMException("user-cancelled-in-test", "AbortError");
    };
  });
  const errs = captureErrors(page);
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("Meta+S");
  // Every cancelled save rejects on a microtask; a later turn of the event
  // loop is the earliest a leaked rejection could surface.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await expect(page.locator(".cm-content").first()).toBeVisible();
  expect(errs).toEqual([]);
});

test("Escape during palette typing doesn't leave residual state", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"][aria-modal="true"]')
    .filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 5000 });
  await palette.locator("input").first().fill("Page View");
  await page.keyboard.press("Escape");
  await expect(palette).not.toBeVisible({ timeout: 2000 });
  // Re-open palette and confirm input is empty.
  await page.keyboard.press("Meta+K");
  await palette.waitFor({ timeout: 5000 });
  const value = await palette.locator("input").first().inputValue();
  expect(value).toBe("");
  expect(errs).toEqual([]);
});

test("malformed KaTeX inline math doesn't propagate as pageerror", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  // KaTeX should render an error span (.katex-error) for bad input,
  // not crash the preview.
  await editor.fill(
    "Broken inline math: $\\frac{1}{}$ and $\\sqrt{$ — done.\n",
  );
  await expect(page.locator(".prose-lumen").first()).toContainText("done.", { timeout: 10_000 });
  expect(errs).toEqual([]);
});

test("malformed KaTeX display math doesn't propagate as pageerror", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "$$\n\\begin{matrix} a & b \\\\ c \\end{wrongenv}\n$$\n",
  );
  // KaTeX renders an error span for bad input; the preview still updates.
  await expect(page.locator(".prose-lumen .katex, .prose-lumen .katex-error, .prose-lumen .katex-display").first()).toBeVisible({ timeout: 10_000 });
  expect(errs).toEqual([]);
});

test("deeply nested blockquote (50 levels) renders without freezing or crashing", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  // Round-25 catches recursion-depth issues in the renderer pipeline.
  const nesting = ">".repeat(50);
  await editor.fill(`${nesting} deeply nested\n`);
  await expect(page.locator(".prose-lumen").first()).toContainText("deeply nested", { timeout: 10_000 });
  expect(errs).toEqual([]);
});

test("wiki-link cycle ([[a]] → [[b]] → [[a]]) doesn't infinite-loop", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  // Self-referential wiki-link should render as a (possibly broken)
  // link, not trigger any recursive resolution loop.
  await editor.fill("[[self]] points to [[self]]. Also [[a]] → [[b]] → [[a]].\n");
  await expect(page.locator(".prose-lumen").first()).toContainText("points to", { timeout: 10_000 });
  expect(errs).toEqual([]);
});

test("pasting >100 KB of plain text into the editor doesn't pageerror", async ({
  page,
}) => {
  // Filling 100 KB and a 20 s wait for the preview to catch up: a stress
  // test that does not fit the default 30 s budget on a cold runner.
  test.slow();
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  // Generate ~100 KB of plain text (paragraphs of lorem-style filler).
  const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
  const huge = Array.from({ length: 800 }, () => para).join("\n\n");
  await editor.fill(huge);
  // The preview catches up with the whole document (debounced render).
  await expect(page.locator(".prose-lumen p").last()).toContainText("magna aliqua.", { timeout: 20_000 });
  await expect(editor).toBeVisible();
  expect(errs).toEqual([]);
});

test("malformed YAML frontmatter renders the doc body without crashing", async ({
  page,
}) => {
  const errs = captureErrors(page);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "---\ntitle: [unclosed bracket\nbroken: : :\nlist:\n  - a\n     bad indent\n---\n\n# Body still here\n",
  );
  // The frontmatter parser falls back to "no frontmatter" or surfaces a
  // small error, but never throws to the page: the body still renders.
  await expect(page.locator(".prose-lumen").first()).toContainText("Body still here", { timeout: 10_000 });
  expect(errs).toEqual([]);
});
