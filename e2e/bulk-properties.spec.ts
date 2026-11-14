import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";

/**
 * Bulk property editing (plan W7.4): five scenarios in a database block's
 * table and kanban, with a Hebrew field and a Hebrew date. Every edited
 * note's body stays byte for byte; one Ctrl+Z puts all of them back.
 */

const N = 30;

function vault(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= N; i++) {
    const id = String(i).padStart(2, "0");
    out[`tasks/Task ${id}.md`] = [
      "---",
      "type: task",
      i % 2 ? `status: "todo"` : "status: todo   # where",
      i % 3 ? "tags: [a]" : "tags:\n  - a\n  - b",
      ...(i % 4 === 0 ? ["שפה: עברית"] : []),
      "---",
      "",
      `Body ${id}. status: todo and tags: [a] in the body.`,
      "",
    ].join(i % 5 === 0 ? "\r\n" : "\n");
  }
  return out;
}

const HUB = ["# Hub", "", "```database", "source: tasks", "type: task", "view: table", "fields: [status, tags, שפה]", "```", ""].join("\n");

async function seed(page: Page, files: Record<string, string>): Promise<boolean> {
  return page.evaluate(async (notes) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("tasks", { create: true });
      for (const [path, text] of Object.entries(notes)) {
        const f = (await dir.getFileHandle(path.slice(6), { create: true })) as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
        if (typeof f.createWritable !== "function") return false;
        const w = await f.createWritable();
        await w.write(text);
        await w.close();
      }
      return true;
    } catch {
      return false;
    }
  }, files);
}

async function readAll(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("tasks");
    const out: Record<string, string> = {};
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) out[`tasks/${name}`] = await (await h.getFile()).text();
    return out;
  });
}

const bodyOf = (t: string) => t.slice((/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(t)?.[0] ?? "").length);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

async function open(page: Page, browserName: string) {
  const original = vault();
  vaultOrSkip(await seed(page, original), browserName);
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(HUB);
  const block = page.getByTestId("database-block").first();
  await expect(block.locator("tr[data-note]")).toHaveCount(N, { timeout: 15_000 });
  return { original, block };
}

async function apply(page: Page, field: string, op: string, value?: string) {
  const bar = page.getByTestId("bulk-edit-bar");
  await expect(bar).toBeVisible();
  await bar.getByTestId("bulk-field").fill(field);
  await bar.getByTestId("bulk-op").selectOption(op);
  if (value !== undefined) await bar.getByTestId("bulk-value").fill(value);
  await bar.getByTestId("bulk-apply").click();
}

async function expectBodiesKept(page: Page, original: Record<string, string>) {
  const now = await readAll(page);
  for (const [p, t] of Object.entries(original)) expect(bodyOf(now[p]), p).toBe(bodyOf(t));
}

test("1. select all, set status; bodies untouched; one Ctrl+Z restores every note", async ({ page, browserName }) => {
  const { original, block } = await open(page, browserName);
  await block.getByTestId("database-select-all").check();
  await expect(page.getByTestId("bulk-selected")).toContainText(String(N));
  await apply(page, "status", "set", "done");
  await expect.poll(async () => Object.values(await readAll(page)).filter((t) => /status: "?done/.test(t)).length, { timeout: 15_000 }).toBe(N);
  await expectBodiesKept(page, original);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => JSON.stringify(await readAll(page)), { timeout: 15_000 }).toBe(JSON.stringify(Object.fromEntries(Object.entries(original).sort())));
});

test("2. Shift-click a range and add a tag", async ({ page, browserName }) => {
  const { original, block } = await open(page, browserName);
  const boxes = block.getByTestId("database-select-row");
  await boxes.nth(2).click();
  await boxes.nth(6).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("bulk-selected")).toContainText("5");
  await apply(page, "tags", "addTag", "פרויקט");
  await expect.poll(async () => Object.values(await readAll(page)).filter((t) => t.includes("פרויקט")).length, { timeout: 15_000 }).toBe(5);
  await expectBodiesKept(page, original);
});

test("3. a Hebrew field: set שפה on notes that lack it", async ({ page, browserName }) => {
  const { original, block } = await open(page, browserName);
  const boxes = block.getByTestId("database-select-row");
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await apply(page, "שפה", "set", "יידיש");
  await expect.poll(async () => Object.values(await readAll(page)).filter((t) => t.includes("שפה: יידיש")).length, { timeout: 15_000 }).toBe(2);
  await expectBodiesKept(page, original);
});

test("4. a Hebrew date as a new field", async ({ page, browserName }) => {
  const { original, block } = await open(page, browserName);
  await block.getByTestId("database-select-row").nth(3).click();
  await apply(page, "תאריך עברי", "set", "י״ד בחשוון תשפ״ז");
  await expect.poll(async () => Object.values(await readAll(page)).filter((t) => t.includes("תאריך עברי: י״ד בחשוון תשפ״ז")).length, { timeout: 15_000 }).toBe(1);
  await expectBodiesKept(page, original);
});

test("5. on the kanban board: select two cards and move them with Set a value", async ({ page, browserName }) => {
  const original = vault();
  vaultOrSkip(await seed(page, original), browserName);
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(HUB.replace("view: table", "view: kanban\ngroupBy: status\ncolumns: [todo, doing, done]"));
  const board = page.getByTestId("database-block").first().getByTestId("database-kanban");
  await expect(board.locator("[data-note]")).toHaveCount(N, { timeout: 15_000 });
  const todo = board.locator('[data-column="todo"]');
  await todo.getByTestId("database-select-row").nth(0).click();
  await todo.getByTestId("database-select-row").nth(1).click();
  await expect(page.getByTestId("bulk-preview")).toContainText("2");
  await apply(page, "status", "set", "doing");
  await expect(board.locator('[data-column="doing"] [data-note]')).toHaveCount(2, { timeout: 15_000 });
  await expectBodiesKept(page, original);
});
