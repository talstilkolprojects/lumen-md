import { test, expect, type Page } from "@playwright/test";

/**
 * Editable database (MASTER_PLAN 4.10), acceptance: over 100 notes, moving
 * kanban cards between columns (with the keyboard) and editing a table cell
 * change exactly the edited value in exactly those files — every other byte
 * of every note stays.
 */

const N = 100;
const STATUSES = ["todo", "doing", "done"];

/** 100 notes with frontmatter in many styles: quotes, comments, CRLF, Hebrew. */
function vault(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= N; i++) {
    const id = String(i).padStart(3, "0");
    const status = STATUSES[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2];
    const lines = [
      "---",
      ...(i % 3 === 0 ? ["# owner: tal"] : []),
      "type: task",
      i % 2 ? `status: "${status}"` : `status: ${status}   # where it is`,
      `rating: ${(i % 5) + 1}`,
      ...(i % 7 === 0 ? ["tags: [a, b]"] : []),
      ...(i % 5 === 0 ? ["שפה: עברית"] : []),
      "---",
      "",
      `Body of task ${id}. status: ${status} appears here too.`,
      "",
    ];
    out[`tasks/Task ${id}.md`] = lines.join(i % 4 === 0 ? "\r\n" : "\n");
  }
  return out;
}

const HUB = [
  "# Board",
  "",
  "```database",
  "source: tasks",
  "type: task",
  "view: kanban",
  "groupBy: status",
  "columns: [todo, doing, done]",
  "fields: [status, rating]",
  "```",
  "",
].join("\n");

async function seed(page: Page, files: Record<string, string>): Promise<boolean> {
  return page.evaluate(async (notes) => {
    const storage = navigator.storage as StorageManager | undefined;
    let root: FileSystemDirectoryHandle;
    try {
      if (!storage?.getDirectory) return false;
      root = await storage.getDirectory();
      const probe = (await root.getFileHandle("__probe", { create: true })) as FileSystemFileHandle & { createWritable?: unknown };
      await root.removeEntry("__probe");
      if (typeof probe.createWritable !== "function") return false;
    } catch {
      return false;
    }
    const dir = await root.getDirectoryHandle("tasks", { create: true });
    for (const [path, text] of Object.entries(notes)) {
      const f = await dir.getFileHandle(path.slice("tasks/".length), { create: true });
      const w = await f.createWritable();
      await w.write(text);
      await w.close();
    }
    return true;
  }, files);
}

async function readAll(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("tasks");
    const out: Record<string, string> = {};
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
      out[`tasks/${name}`] = await (await h.getFile()).text();
    }
    return out;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("100 notes: kanban moves and a cell edit change only the edited values", async ({ page }) => {
  test.setTimeout(90_000);
  const original = vault();
  test.skip(!(await seed(page, original)), "OPFS writes are unavailable in this engine's test context");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(HUB);

  const block = page.getByTestId("database-block").first();
  const board = block.getByTestId("database-kanban");
  await expect(board.locator("[data-note]")).toHaveCount(N, { timeout: 15_000 });
  const column = (name: string) => board.locator(`[data-column="${name}"]`);
  await expect(column("todo").locator("[data-note]")).toHaveCount(33);

  /** Keyboard drag: Space picks the card up, → moves a column, Space drops it. */
  const move = async (note: string, steps: number, to: string) => {
    const handle = board.getByRole("button", { name: `Move ${note}` });
    await handle.focus();
    await page.keyboard.press("Space");
    for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(column(to).locator(`[data-note="tasks/${note}.md"]`)).toBeVisible({ timeout: 5_000 });
  };
  await move("Task 003", 1, "doing");
  await move("Task 006", 2, "done");
  await expect(column("todo").locator("[data-note]")).toHaveCount(31);

  // A cell, in the table — found with the filter (the table is grouped by
  // status and renders only the rows on screen).
  await block.getByTestId("database-view-table").click();
  await block.getByTestId("database-filter").fill('file.name = "Task 009" OR rating > 100');
  await block.getByRole("button", { name: "Edit rating of Task 009" }).click();
  const input = block.getByRole("textbox", { name: "Edit rating of Task 009" });
  await input.fill("42");
  await input.press("Enter");
  await expect(block.getByRole("button", { name: "Edit rating of Task 009" })).toHaveText("42");

  const expected = { ...original };
  const sub = (path: string, from: RegExp, to: string) => {
    const next = expected[path].replace(from, to);
    expect(next).not.toBe(expected[path]);
    expected[path] = next;
  };
  sub("tasks/Task 003.md", /^status: "todo"/m, 'status: "doing"');
  sub("tasks/Task 006.md", /^status: todo {3}#/m, "status: done   #");
  sub("tasks/Task 009.md", /^rating: 5$/m, "rating: 42");

  await expect.poll(async () => (await readAll(page))["tasks/Task 009.md"], { timeout: 5_000 }).toBe(expected["tasks/Task 009.md"]);
  const after = await readAll(page);
  expect(Object.keys(after).sort()).toEqual(Object.keys(original).sort());
  const changed = Object.keys(after).filter((p) => after[p] !== original[p]).sort();
  expect(changed).toEqual(["tasks/Task 003.md", "tasks/Task 006.md", "tasks/Task 009.md"]);
  // Byte for byte: the edited files differ only in the edited value.
  for (const p of Object.keys(after)) expect(after[p], p).toBe(expected[p]);
});
