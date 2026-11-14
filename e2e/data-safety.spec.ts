import { test, expect } from "@playwright/test";

/**
 * Data safety (MASTER_PLAN v3 §14) — part A, the history store (T35):
 * what the user typed shows up in Version History without them saving,
 * a restore brings it back, and the restore itself can be undone.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

/**
 * Can this engine write OPFS files at all here? Playwright's WebKit runs in
 * an ephemeral context, where WebKit may refuse OPFS writes; the vault can't
 * work there, so the vault tests skip (and say why) instead of failing.
 */
async function opfsWritable(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("__probe", { create: true });
      const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
      if (typeof h.createWritable === "function") {
        const w = await h.createWritable();
        await w.write("x");
        await w.close();
      } else {
        const src =
          "self.onmessage=async()=>{try{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle('__probe',{create:true});const a=await f.createSyncAccessHandle();a.write(new Uint8Array([120]),{at:0});a.flush();a.close();postMessage(true)}catch(e){postMessage(false)}}";
        const ok = await new Promise<boolean>((res) => {
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
          w.onmessage = (e) => res(e.data === true);
          w.onerror = () => res(false);
          w.postMessage(0);
          setTimeout(() => res(false), 5000);
        });
        if (!ok) return false;
      }
      await root.removeEntry("__probe");
      return true;
    } catch {
      return false;
    }
  });
}

async function openHistory(page: import("@playwright/test").Page) {
  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"]').filter({ has: page.locator("input") });
  await expect(palette).toBeVisible();
  await palette.locator("input").first().fill("version history");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Version History/i);
  await page.keyboard.press("Enter");
  const panel = page.locator('[role="dialog"][aria-label="Version History"]');
  await expect(panel).toBeVisible({ timeout: 5000 });
  return panel;
}

test("a version is kept without saving, restores, and the restore is undoable", async ({ page }) => {
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# First draft\n\nwritten without pressing save");
  // Hiding the page is a save point (pagehide / visibilitychange flush).
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  await editor.press("ControlOrMeta+a");
  await editor.fill("# Second draft");

  const panel = await openHistory(page);
  const entries = panel.locator("button").filter({ hasText: /chars/ });
  await expect(entries.first()).toBeVisible({ timeout: 5000 });
  // Pick the version that holds the first draft and restore it.
  const count = await entries.count();
  let restored = false;
  for (let i = 0; i < count && !restored; i++) {
    await entries.nth(i).click();
    if ((await panel.locator("pre").first().textContent())?.includes("First draft")) {
      await panel.getByRole("button", { name: /Restore this version/i }).click();
      restored = true;
    }
  }
  expect(restored).toBe(true);
  await expect(panel).toBeHidden();
  await expect(editor).toContainText("First draft");

  // The text the restore replaced is itself in the history now.
  const again = await openHistory(page);
  await expect(again.locator("button").filter({ hasText: /before restore/i }).first()).toBeVisible();
});

test("auto-backups no longer create files in the vault", async ({ page }) => {
  // Let the auto-backup run once (it fires 30 s after the last edit; the
  // pagehide flush forces it now).
  await page.locator(".cm-content").first().click();
  await page.keyboard.type(" edit");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const names = await page.evaluate(async () => {
    try {
      const root = (await navigator.storage.getDirectory()) as unknown as { keys?: () => AsyncIterable<string>; entries?: () => AsyncIterable<[string, unknown]> };
      const out: string[] = [];
      if (root.keys) for await (const name of root.keys()) out.push(name);
      else if (root.entries) for await (const [name] of root.entries()) out.push(name);
      return out;
    } catch {
      // No OPFS in this engine: nothing can be written there either.
      return [];
    }
  });
  expect(names).not.toContain("backups");
});

/**
 * Safari before 26 (and Playwright WebKit) has no createWritable on the main
 * thread: vault writes go through a sync-access-handle worker. Remove the
 * method here so every engine exercises that path.
 */
test("saving to the vault works without createWritable (Safari path)", async ({ page }) => {
  await page.addInitScript(() => {
    const proto = (globalThis as { FileSystemFileHandle?: { prototype: Record<string, unknown> } }).FileSystemFileHandle?.prototype;
    if (proto) delete proto.createWritable;
  });
  await page.reload();
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  test.skip(!(await opfsWritable(page)), "OPFS writes are unavailable in this engine's test context");
  const run = (id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# Written by the worker");
  await run("file.saveToWorkspace");
  await expect(page.locator("aside.file-tree .file-tree-name", { hasText: "Welcome.md" })).toBeVisible({ timeout: 10_000 });
  const text = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle("Welcome.md")).getFile();
    return file.text();
  });
  expect(text).toBe("# Written by the worker");
});

/** Part B — safe files (T46): rename keeps links, delete is undoable. */
test("renaming a note rewrites links to it; deleting it goes to the trash with Undo", async ({ page }) => {
  test.skip(!(await opfsWritable(page)), "OPFS writes are unavailable in this engine's test context");
  const run = (id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();

  // Note 1: "Welcome.md" saved into the vault.
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# Target note");
  await run("file.saveToWorkspace");
  const tree = page.locator("aside.file-tree");
  await expect(tree.locator(".file-tree-name", { hasText: "Welcome.md" })).toBeVisible({ timeout: 10_000 });

  // Note 2 links to it.
  await run("file.new");
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("see [[Welcome]] and [[Welcome#Target note|this]]");
  await run("file.saveToWorkspace");
  await expect(tree.locator(".file-tree-name")).toHaveCount(2, { timeout: 10_000 });

  // Rename Welcome.md → Renamed.md in the tree.
  const row = tree.locator(".file-tree-item", { has: page.locator(".file-tree-name", { hasText: "Welcome.md" }) });
  await row.hover();
  await row.getByRole("button", { name: /rename/i }).click();
  const input = tree.locator("input.file-tree-input");
  await input.fill("Renamed");
  await input.press("Enter");
  await expect(tree.locator(".file-tree-name", { hasText: "Renamed.md" })).toBeVisible({ timeout: 10_000 });

  // The other note's links follow (it is the open note).
  await expect(page.getByText(/Links updated in 1 notes/i)).toBeVisible({ timeout: 10_000 });
  const other = tree.locator(".file-tree-name").filter({ hasNotText: "Renamed.md" }).first();
  await other.click();
  await expect(editor).toContainText("[[Renamed]] and [[Renamed#Target note|this]]", { timeout: 10_000 });

  // Delete → trash, Undo brings it back.
  const renamed = tree.locator(".file-tree-item", { has: page.locator(".file-tree-name", { hasText: "Renamed.md" }) });
  await renamed.hover();
  await renamed.getByRole("button", { name: /delete/i }).click();
  await expect(tree.locator(".file-tree-name", { hasText: "Renamed.md" })).toHaveCount(0, { timeout: 10_000 });
  const toastEl = page.getByRole("status").filter({ hasText: /moved to the trash/i });
  await expect(toastEl).toBeVisible({ timeout: 5000 });
  await toastEl.getByRole("button", { name: "Undo" }).click();
  await expect(tree.locator(".file-tree-name", { hasText: "Renamed.md" })).toBeVisible({ timeout: 10_000 });
});

/** Part C — export everything (T47): the vault comes out as a .zip with paths. */
test("the whole vault exports as a zip", async ({ page }) => {
  test.skip(!(await opfsWritable(page)), "OPFS writes are unavailable in this engine's test context");
  const run = (id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# שלום מהכספת");
  await run("file.saveToWorkspace");
  await expect(page.locator("aside.file-tree .file-tree-name", { hasText: "Welcome.md" })).toBeVisible({ timeout: 10_000 });

  const download = page.waitForEvent("download", { timeout: 15_000 });
  await run("vault.export");
  // Chromium offers "zip or folder"; the zip is the default choice.
  const dialog = page.getByRole("dialog").filter({ has: page.locator("select") });
  // The choice dialog can take a moment on a slow CI runner: wait for
  // whichever comes first — the download or the dialog.
  const first = await Promise.race([
    download.then(() => "download" as const),
    dialog.waitFor({ timeout: 10_000 }).then(() => "dialog" as const, () => "none" as const),
  ]);
  if (first === "dialog") await dialog.getByRole("button", { name: /^(OK|Confirm)$/i }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^lumen-vault-\d{4}-\d{2}-\d{2}\.zip$/);
  const stream = await d.createReadStream();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  // A real zip: local header signature, and the note's name inside.
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  expect(bytes.includes(Buffer.from("Welcome.md"))).toBe(true);
});

/**
 * Part D — safe git (plan 3.3): a pull is a three-way merge into the vault.
 * Overlapping edits open the resolution screen, a note open with unsaved
 * edits gets the merge in the editor (not overwritten), and nothing is deleted —
 * not the file deleted upstream, not the file git never tracked.
 *
 * The remote commit is made in the browser's own git store (no network): the
 * merge half of the pull (`integrateIntoVault`) and the real dialogs are
 * what is tested. The modules are imported from the dev server.
 */
test("git pull merges three ways, opens the conflict screen, keeps unsaved edits, and deletes nothing", async ({ page }) => {
  const dev = await page.evaluate(() => !!document.querySelector('script[src*="/@vite/client"]'));
  test.skip(!dev, "imports the git modules from the dev server");
  test.skip(!(await opfsWritable(page)), "OPFS writes are unavailable in this engine's test context");
  const repo = `safe-git-${Date.now().toString(36)}`;
  // The vault opens shortly after start-up.
  await expect
    .poll(() => page.evaluate(async () => (await import(/* @vite-ignore */ "/src/storage/workspace.ts")).isOPFSAvailable()), { timeout: 10_000 })
    .toBe(true);

  const before = await page.evaluate(async (repo) => {
    const ws = await import(/* @vite-ignore */ "/src/storage/workspace.ts");
    const g = await import(/* @vite-ignore */ "/src/sync/git.ts");
    const { fs, git } = await g.__gitRuntime();
    const dir = `/git/${repo}`;
    const author = { name: "Test", email: "test@example.com" };
    const base: Record<string, string> = {
      "c.md": "x\ny\nz",
      "open.md": "alpha\nbeta\ngamma",
      "gone.md": "deleted upstream",
    };
    await fs.promises.mkdir("/git").catch(() => undefined);
    await fs.promises.mkdir(dir);
    await git.init({ fs, dir, defaultBranch: "main" });
    for (const [p, text] of Object.entries(base)) {
      await fs.promises.writeFile(`${dir}/${p}`, text);
      await git.add({ fs, dir, filepath: p });
      await ws.writeWorkspaceFile(`${repo}/${p}`, text);
    }
    const baseOid = await git.commit({ fs, dir, message: "base", author });
    // Local work: an edit to c.md and a file git never tracked.
    await ws.writeWorkspaceFile(`${repo}/c.md`, "x\nLOCAL\nz");
    await ws.writeWorkspaceFile(`${repo}/untracked.md`, "mine, never committed");
    // The remote moves on: same line of c.md, the end of open.md, gone.md deleted.
    await fs.promises.writeFile(`${dir}/c.md`, "x\nREMOTE\nz");
    await fs.promises.writeFile(`${dir}/open.md`, "alpha\nbeta\ngamma remote");
    await git.add({ fs, dir, filepath: "c.md" });
    await git.add({ fs, dir, filepath: "open.md" });
    await fs.promises.unlink(`${dir}/gone.md`);
    await git.remove({ fs, dir, filepath: "gone.md" });
    const theirs = await git.commit({ fs, dir, message: "remote", author, ref: "refs/remotes/origin/main", parent: [baseOid] });
    await git.checkout({ fs, dir, ref: "main", force: true });
    (window as unknown as { __theirs: string }).__theirs = theirs;
    return (await ws.listWorkspace({ includeHidden: true })).map((e: { path: string }) => e.path).filter((p: string) => p.startsWith(`${repo}/`)).sort();
  }, repo);
  expect(before).toEqual([`${repo}/c.md`, `${repo}/gone.md`, `${repo}/open.md`, `${repo}/untracked.md`]);
  const editor = page.locator(".cm-content").first();

  // open.md is open with an unsaved edit; pull at once (the merge half),
  // then the summary and the resolution screen.
  await page.evaluate(async (repo) => {
    const g = await import(/* @vite-ignore */ "/src/sync/git.ts");
    const docs = await import(/* @vite-ignore */ "/src/store/gitPullDocs.ts");
    const { useAppStore } = await import(/* @vite-ignore */ "/src/store/useStore.ts");
    const content = "ALPHA local\nbeta\ngamma";
    useAppStore.setState({
      doc: { name: "open.md", content, workspaceName: `${repo}/open.md`, dirty: true },
      openTabs: [{ id: `${repo}/open.md`, name: "open.md", content, workspaceName: `${repo}/open.md`, dirty: true }],
    });
    const result = await g.integrateIntoVault(repo, (window as unknown as { __theirs: string }).__theirs);
    (window as unknown as { __pull: unknown }).__pull = result;
    void docs.reportPull(result);
  }, repo);
  const summary = page.getByRole("dialog").filter({ hasText: /Nothing deleted/ });
  await expect(summary).toBeVisible({ timeout: 10_000 });
  await expect(summary).toContainText(/Deleted upstream, kept here/);
  await summary.getByRole("button", { name: "OK" }).click();

  const conflict = page.getByRole("dialog").filter({ hasText: `Git conflict — ${repo}/c.md` });
  await expect(conflict).toBeVisible({ timeout: 10_000 });
  await expect(conflict).toContainText("LOCAL");
  await expect(conflict).toContainText("REMOTE");
  await conflict.getByRole("button", { name: "Take remote" }).click();
  await expect(conflict).toBeHidden();

  // The unsaved edit and the remote change are both in the editor, and
  // reach the file through the normal save.
  await expect(editor).toContainText("ALPHA local");
  await expect(editor).toContainText("gamma remote");
  await expect
    .poll(() => page.evaluate(async (repo) => (await import(/* @vite-ignore */ "/src/storage/workspace.ts")).readWorkspaceFile(`${repo}/open.md`), repo), { timeout: 10_000 })
    .toBe("ALPHA local\nbeta\ngamma remote");

  const after = await page.evaluate(async (repo) => {
    const ws = await import(/* @vite-ignore */ "/src/storage/workspace.ts");
    const paths = (await ws.listWorkspace({ includeHidden: true })).map((e: { path: string }) => e.path).filter((p: string) => p.startsWith(`${repo}/`)).sort();
    const read = (p: string) => ws.readWorkspaceFile(`${repo}/${p}`);
    const pull = (window as unknown as { __pull: { deletedFiles: number; conflicts: unknown[] } }).__pull;
    return { paths, c: await read("c.md"), gone: await read("gone.md"), untracked: await read("untracked.md"), deleted: pull.deletedFiles, conflicts: pull.conflicts.length };
  }, repo);
  // 0 files deleted on pull.
  for (const p of before) expect(after.paths).toContain(p);
  expect(after.deleted).toBe(0);
  expect(after.conflicts).toBe(1);
  expect(after.c).toBe("x\nREMOTE\nz");
  expect(after.gone).toBe("deleted upstream");
  expect(after.untracked).toBe("mine, never committed");
});
