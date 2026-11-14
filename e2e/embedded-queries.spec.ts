import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W2.12 — embedded queries and saved searches, in the browser:
 *   - a ```query block and a ```dataview block in the preview list the
 *     matching notes of the vault, and update when a note is saved;
 *   - a search saved from the search dialog shows in the sidebar and opens
 *     the dialog on its query again.
 *
 * The vault is OPFS: Playwright's WebKit has no writable OPFS in its test
 * context, so the spec runs where it can seed one (chromium, firefox).
 */

interface Probe {
  ensureIndex(force?: boolean): Promise<void>;
  writeWorkspaceFile(path: string, content: string): Promise<void>;
}

async function canSeed(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("__probe", { create: true });
      const ok = typeof (fh as unknown as { createWritable?: unknown }).createWritable === "function";
      await root.removeEntry("__probe");
      return ok;
    } catch {
      return false;
    }
  });
}

async function write(page: Page, path: string, content: string): Promise<void> {
  await page.evaluate(
    async ([p, c]) => {
      const m = await (window as unknown as { __lumen: { vaultIndex(): Promise<Probe> } }).__lumen.vaultIndex();
      await m.writeWorkspaceFile(p, c);
    },
    [path, content] as const,
  );
}

type View = { state: { doc: { length: number } }; dispatch(tr: unknown): void };

async function setNote(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, userEvent: "input" });
  }, text);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.removeItem("lumen-saved-searches");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
  test.skip(!(await canSeed(page)), "no writable OPFS in this browser's test context");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) await root.removeEntry(name, { recursive: true });
  });
  await write(page, "projects/alpha.md", "---\ntags: [project]\nstatus: active\n---\n# Alpha\n\nThe alpha plan.\n");
  await write(page, "projects/beta.md", "---\ntags: [project]\nstatus: blocked\n---\n# Beta\n\nבטא חסום. #blocked\n");
  await write(page, "notes/other.md", "# Other\n\nNothing here.\n");
});

test("a query block and a dataview block list the vault's notes and follow a save", async ({ page }) => {
  await page.keyboard.press("Meta+2");
  await setNote(page, ["# Dashboard", "", "```query", "tag:project", "sort: name", "```", "", "```dataview", 'TABLE status FROM #project SORT file.name', "```", ""].join("\n"));
  const query = page.locator('.lumen-query-block[data-query-kind="query"]');
  const dataview = page.locator('.lumen-query-block[data-query-kind="dataview"]');
  await expect(query.locator("a.wiki-link")).toHaveText(["alpha", "beta"], { timeout: 15_000 });
  await expect(dataview.locator("tbody tr")).toHaveCount(2);
  await expect(dataview.locator("tbody tr").nth(1)).toContainText("blocked");

  // A new note with the tag, saved: both blocks show it.
  const t0 = Date.now();
  await write(page, "projects/gamma.md", "---\ntags: [project]\nstatus: done\n---\n# Gamma\n");
  await expect(query.locator("a.wiki-link")).toHaveText(["alpha", "beta", "gamma"], { timeout: 5_000 });
  await expect(dataview.locator("tbody tr")).toHaveCount(3);
  test.info().annotations.push({ type: "perf", description: `save → both blocks updated (incl. polling): ${Date.now() - t0} ms` });

  // A note that loses the tag drops out.
  await write(page, "projects/beta.md", "# Beta\n\nNo longer a project.\n");
  await expect(query.locator("a.wiki-link")).toHaveText(["alpha", "gamma"], { timeout: 5_000 });
  await expect(dataview.locator("tbody tr")).toHaveCount(2);
});

test("a dataview block it can't run says so", async ({ page }) => {
  await page.keyboard.press("Meta+2");
  await setNote(page, "```dataview\nTASK FROM #project\n```\n");
  await expect(page.locator('.lumen-query-block [role="alert"]')).toBeVisible({ timeout: 15_000 });
});

test("a saved search shows in the sidebar and opens the dialog on its query", async ({ page }) => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-search", { detail: { query: "tag:project" } })));
  const input = page.locator(".cmd-palette-search input");
  await expect(page.getByTestId("search-save")).toBeVisible({ timeout: 10_000 });
  await expect(input).toHaveValue("tag:project");
  await page.getByTestId("search-save").click();
  await expect(page.getByTestId("search-save")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  // Open the workspace sidebar: the saved search is there.
  await page.getByRole("button", { name: "Toggle workspace" }).first().click();
  const saved = page.getByTestId("saved-searches");
  await expect(saved).toBeVisible({ timeout: 10_000 });
  await saved.getByRole("button", { name: "tag:project" }).click();
  await expect(page.getByTestId("search-save")).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  await expect(input).toHaveValue("tag:project");
});
