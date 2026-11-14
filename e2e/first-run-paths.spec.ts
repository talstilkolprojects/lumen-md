import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plan W11.P6 — import-first onboarding, one test per path of the first
 * run's last step: an empty note, "Bring your notes" (into the import
 * wizard, then its report, a sample search and Undo), and an Obsidian folder
 * opened as it is. Acceptance: with 1,000 notes, the first search result
 * shows ≤ 3 min after clicking "Import".
 *
 * The Keep export is synthetic (made here in Google Takeout's shape: one
 * JSON per note), labelled so; the real exports are W10.O9.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("fr-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("fr-cleared", "1");
    }
  });
});

async function toLastStep(page: Page) {
  await page.goto("/");
  const setup = page.getByRole("dialog", { name: "Welcome to Lumen" });
  await expect(setup).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < 3; i++) await setup.getByRole("button", { name: "Next" }).click();
  return setup;
}

/** A synthetic Google Takeout Keep folder with `n` notes; every note mentions "lighthouse". */
function keepTakeout(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "keep-"));
  const keep = join(dir, "Takeout", "Keep");
  mkdirSync(keep, { recursive: true });
  const t0 = 1_700_000_000_000_000;
  for (let i = 0; i < n; i++) {
    const note = { title: `Note ${i}`, textContent: `Synthetic note ${i} about the lighthouse.\nשורה בעברית ${i}.`, labels: [{ name: i % 2 ? "work" : "home" }], createdTimestampUsec: t0 + i, userEditedTimestampUsec: t0 + i, isTrashed: false, isArchived: false, isPinned: false, color: "DEFAULT" };
    writeFileSync(join(keep, `Note ${i}.json`), JSON.stringify(note));
  }
  return dir;
}

test("empty note: setup ends on the user's first note", async ({ page }) => {
  const setup = await toLastStep(page);
  await setup.getByRole("radio", { name: /An empty vault/ }).check();
  await setup.getByRole("button", { name: "Start writing" }).click();
  await expect(setup).toBeHidden();
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

test("Bring your notes: six sources, the wizard on Google Keep, report, search and undo; 1,000 notes searchable ≤ 3 min", async ({ page }) => {
  test.setTimeout(240_000);
  const dir = keepTakeout(1000);
  try {
    const setup = await toLastStep(page);
    await setup.getByRole("radio", { name: /Bring your notes/ }).check();
    const sources = setup.getByRole("group", { name: "Where are your notes now?" });
    await expect(sources.getByRole("radio")).toHaveCount(6);
    await sources.getByRole("radio", { name: "Google Keep" }).check();
    await setup.getByRole("button", { name: "Choose the export" }).click();
    const wizard = page.getByTestId("import-wizard");
    await expect(wizard).toBeVisible();
    await expect(page.getByTestId("import-source-keep")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("import-folder-input").setInputFiles(dir);
    const start = page.getByTestId("import-start");
    await expect(start).toBeVisible({ timeout: 60_000 });
    const clicked = Date.now();
    await start.click();
    await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("import-undo")).toBeVisible();
    await page.getByTestId("import-search").click();
    await expect(page.locator("[data-search-index]").first()).toBeVisible({ timeout: 180_000 });
    const ms = Date.now() - clicked;
    test.info().annotations.push({ type: "import-to-first-result-ms", description: String(ms) });
    expect(ms).toBeLessThanOrEqual(180_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Open an Obsidian folder: the folder becomes the vault, no note is written into it", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "showDirectoryPicker is Chromium-only; the folder here is an OPFS directory handed to the picker");
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const v = await root.getDirectoryHandle("obsidian-vault", { create: true });
      const f = await (await v.getFileHandle("Inbox.md", { create: true })).createWritable();
      await f.write("# Inbox\n");
      await f.close();
      return v;
    };
  });
  const setup = await toLastStep(page);
  await setup.getByRole("radio", { name: /Open an Obsidian folder/ }).check();
  await setup.getByRole("button", { name: "Open the folder" }).click();
  await expect(setup).toBeHidden();
  const names = await page.evaluate(async () => {
    const v = await (await navigator.storage.getDirectory()).getDirectoryHandle("obsidian-vault");
    const out: string[] = [];
    for await (const [n] of (v as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) out.push(n);
    return out.filter((n) => n.endsWith(".md"));
  });
  expect(names).toEqual(["Inbox.md"]);
});
