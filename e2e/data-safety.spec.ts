import { test, expect } from "@playwright/test";
import { testHooks, type LumenTestWindow } from "./_lumen";
import { opfsWritable, vaultOrSkip } from "./_opfs";
import { missingToolVerdict } from "./_gate";

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

test("G4: a version is kept without saving, restores, and the restore is undoable", async ({ page }) => {
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

test("G10: auto-backups no longer create files in the vault", async ({ page }) => {
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
test("G9: saving to the vault works without createWritable (Safari path)", async ({ page, browserName }) => {
  await page.addInitScript(() => {
    const proto = (globalThis as { FileSystemFileHandle?: { prototype: Record<string, unknown> } }).FileSystemFileHandle?.prototype;
    if (proto) delete proto.createWritable;
  });
  await page.reload();
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  vaultOrSkip(await opfsWritable(page), browserName);
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
test("G5, G6: renaming a note rewrites links to it; deleting it goes to the trash with Undo", async ({ page, browserName }) => {
  vaultOrSkip(await opfsWritable(page), browserName);
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
test("G7: the whole vault exports as a zip", async ({ page, browserName }) => {
  // Save, a lazy export chunk, a dialog and a download: more than the default 30 s budget on a cold runner.
  test.slow();
  vaultOrSkip(await opfsWritable(page), browserName);
  const run = (id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# שלום מהכספת");
  await run("file.saveToWorkspace");
  await expect(page.locator("aside.file-tree .file-tree-name", { hasText: "Welcome.md" })).toBeVisible({ timeout: 10_000 });

  // An engine with showDirectoryPicker (Chromium) asks "zip or folder" first
  // and downloads nothing until it is answered; the others go straight to the
  // zip. Decide which from the engine, not from a race: the old race gave the
  // dialog 10 s, and when the lazy export chunk took longer on a cold runner
  // the test stopped looking for it and waited for a download that the
  // unanswered dialog was holding back (plan 0.5).
  const asksWhere = await page.evaluate(() => "showDirectoryPicker" in window);
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await run("vault.export");
  if (asksWhere) {
    // The zip is the default choice.
    const dialog = page.getByRole("dialog").filter({ has: page.locator("select") });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: /^(OK|Confirm)$/i }).click();
  }
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
 * what is tested. The modules come through window.__lumenTest (e2e/_lumen.ts),
 * on the dev server and on the gate's production build alike.
 */
test("G2: git pull merges three ways, opens the conflict screen, keeps unsaved edits, and deletes nothing", async ({ page, browserName }) => {
  await testHooks(page);
  vaultOrSkip(await opfsWritable(page), browserName);
  const repo = `safe-git-${Date.now().toString(36)}`;
  // The vault opens shortly after start-up.
  await expect
    .poll(() => page.evaluate(async () => (await (window as unknown as LumenTestWindow).__lumenTest.load("storage/workspace")).isOPFSAvailable()), { timeout: 10_000 })
    .toBe(true);

  const before = await page.evaluate(async (repo) => {
    const ws = await (window as unknown as LumenTestWindow).__lumenTest.load("storage/workspace");
    const g = await (window as unknown as LumenTestWindow).__lumenTest.load("sync/git");
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
    const g = await (window as unknown as LumenTestWindow).__lumenTest.load("sync/git");
    const docs = await (window as unknown as LumenTestWindow).__lumenTest.load("store/gitPullDocs");
    const { useAppStore } = await (window as unknown as LumenTestWindow).__lumenTest.load("store/useStore");
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
    .poll(() => page.evaluate(async (repo) => (await (window as unknown as LumenTestWindow).__lumenTest.load("storage/workspace")).readWorkspaceFile(`${repo}/open.md`), repo), { timeout: 10_000 })
    .toBe("ALPHA local\nbeta\ngamma remote");

  const after = await page.evaluate(async (repo) => {
    const ws = await (window as unknown as LumenTestWindow).__lumenTest.load("storage/workspace");
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

/* ─── Plan 3.7: the rest of the G1–G11 matrix ───────────────────────────
 * Every data-loss path from the weakness list has a test here, its id first
 * in the title: G1 durable storage · G2 git pull · G3 public clone + LFS ·
 * G4 history · G5 rename · G6 trash · G7 export · G9 failed writes ·
 * G10 backups out of the vault · G11 Obsidian/Notion import.
 * G8 (sync providers connected, settings → connect → sync) is
 * e2e/sync-providers.spec.ts on the plan 3.5 stack (#291).
 */

const runCmd = (page: import("@playwright/test").Page, id: string) =>
  page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** The text of a file in the vault (OPFS root), or null. */
function vaultText(page: import("@playwright/test").Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    try {
      let dir = await navigator.storage.getDirectory();
      const parts = p.split("/");
      for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
      return await (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
    } catch {
      return null;
    }
  }, path);
}

/** G1 — the app asks the browser to keep its storage, and says when it was refused. */
test("G1: durable storage is requested at start, its state is shown, and it can be asked again", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __persist: { calls: number; grant: boolean } };
    w.__persist = { calls: 0, grant: false };
    const storage = navigator.storage as StorageManager;
    Object.defineProperty(storage, "persisted", { value: async () => w.__persist.grant, configurable: true });
    Object.defineProperty(storage, "persist", {
      value: async () => {
        w.__persist.calls++;
        return w.__persist.grant;
      },
      configurable: true,
    });
  });
  await page.reload();
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __persist: { calls: number } }).__persist.calls)).toBeGreaterThanOrEqual(1);

  await runCmd(page, "ai.doctor");
  const doctor = page.locator('[role="dialog"][aria-label="AI doctor"]');
  await expect(doctor).toBeVisible({ timeout: 10_000 });
  const storage = doctor.getByTestId("doctor-storage");
  await expect(storage).toHaveAttribute("data-status", "warn", { timeout: 20_000 });
  await expect(storage).toContainText("evictable");
  // The browser grants it this time: the fix asks again and the check turns green.
  await page.evaluate(() => ((window as unknown as { __persist: { grant: boolean } }).__persist.grant = true));
  await storage.getByRole("button").first().click();
  await expect(storage).toHaveAttribute("data-status", "ok", { timeout: 20_000 });
  await expect(storage).toContainText("durable");
});

/**
 * G3 — clone a public repository without a token, keep its history, and say
 * which files are Git LFS pointers instead of passing them off as content.
 * The repository is a real one, served by `git http-backend` (smart HTTP)
 * through request interception at an origin the CSP allows.
 */
test("G3: a public repository clones without a token, LFS pointers are named", async ({ page, browserName }, testInfo) => {
  vaultOrSkip(await opfsWritable(page), browserName);
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const backend = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim() + "/git-http-backend";
  // On the gate a missing http-backend fails G3; only a local run may skip it (plan W10.B17, audit 3.7).
  const backendVerdict = missingToolVerdict(spawnSync(backend, [], { env: { REQUEST_METHOD: "GET" } }).error === undefined, process.env);
  if (backendVerdict === "fail") {
    throw new Error(`G3 cannot run: git http-backend is not installed at ${backend}. The gate never skips G3; install git (it ships git-http-backend) on this machine.`);
  }
  // skip-reason: local runs only — needs git's http-backend to serve a real repository (git ships it on macOS and Ubuntu); the gate fails instead | task: 3.7 | until: 2027-05-12
  test.skip(backendVerdict === "skip", "git http-backend is not installed (local run; the gate fails here instead)");

  const root = mkdtempSync(join(tmpdir(), `lumen-g3-${browserName}-`));
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git(root, "init", "-q", "work");
  writeFileSync(join(work, "readme.md"), "# public\n\nfirst");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one");
  writeFileSync(join(work, "readme.md"), "# public\n\nsecond");
  writeFileSync(join(work, "big.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 1048576\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "two");
  git(root, "clone", "-q", "--bare", "work", "public.git");

  const authHeaders: string[] = [];
  await page.route("http://127.0.0.1:8787/git/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST" } });
    const headers = await req.allHeaders();
    if (headers.authorization) authHeaders.push(headers.authorization);
    const out = spawnSync(backend, [], {
      input: req.postDataBuffer() ?? Buffer.alloc(0),
      env: {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname.replace(/^\/git/, ""),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method(),
        CONTENT_TYPE: headers["content-type"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    const raw = out.stdout as Buffer;
    const split = raw.indexOf("\r\n\r\n");
    const head = raw.subarray(0, split).toString("latin1");
    const respHeaders: Record<string, string> = { "Access-Control-Allow-Origin": "*" };
    let status = 200;
    for (const line of head.split("\r\n")) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10);
      else if (k) respHeaders[k] = v;
    }
    await route.fulfill({ status, headers: respHeaders, body: raw.subarray(split + 4) });
  });

  await runCmd(page, "git.clone");
  const prompt = page.getByRole("dialog").filter({ has: page.locator("input") });
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await prompt.locator("input").fill("http://127.0.0.1:8787/git/public.git");
  await prompt.locator("input").press("Enter");
  const done = page.getByRole("dialog").filter({ hasText: /Cloned|cloned/ });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(done).toContainText("big.bin"); // named as an LFS pointer, not imported as content
  expect(authHeaders).toEqual([]); // no token was needed or sent
  testInfo.annotations.push({ type: "repo", description: root });
  await expect.poll(() => vaultText(page, "public/readme.md"), { timeout: 10_000 }).toBe("# public\n\nsecond");
});

/** G9 — a failed write is announced and retried; the text is not lost. */
test("G9: a vault write refused for quota shows a message and is retried until it lands", async ({ page, browserName }) => {
  vaultOrSkip(await opfsWritable(page), browserName);
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# saved once");
  await runCmd(page, "file.saveToWorkspace");
  await expect.poll(() => vaultText(page, "Welcome.md"), { timeout: 10_000 }).toBe("# saved once");

  // The next two writes fail as a full disk does.
  await page.evaluate(() => {
    const w = window as unknown as { __failWrites: number };
    w.__failWrites = 2;
    const proto = FileSystemFileHandle.prototype as unknown as { createWritable: (...a: unknown[]) => Promise<unknown> };
    const real = proto.createWritable;
    proto.createWritable = function (this: unknown, ...a: unknown[]) {
      if (w.__failWrites > 0) {
        w.__failWrites--;
        return Promise.reject(new DOMException("The quota has been exceeded.", "QuotaExceededError"));
      }
      return real.apply(this, a);
    };
  });
  await editor.press("ControlOrMeta+a");
  await editor.fill("# written while the disk was full");
  await expect(page.getByText(/storage for this site is full/i)).toBeVisible({ timeout: 10_000 });
  // The retries (2 s, then 4 s) land once space is back.
  await expect.poll(() => vaultText(page, "Welcome.md"), { timeout: 20_000 }).toBe("# written while the disk was full");
  expect(await page.evaluate(() => (window as unknown as { __failWrites: number }).__failWrites)).toBe(0);
});

/** G11 — an Obsidian vault and a Notion export come in note by note, not merged into one. */
test("G11: Obsidian and Notion imports keep one file per note, with paths and links", async ({ page, browserName }) => {
  vaultOrSkip(await opfsWritable(page), browserName);
  const { zip } = await import("../src/storage/zip");
  const id = "0123456789abcdef0123456789abcdef";
  const archives = [
    {
      name: "MyVault.zip",
      files: [
        { name: "MyVault/.obsidian/app.json", data: "{}" },
        { name: "MyVault/Daily/2026-10-24.md", data: "# Today\n\nsee [[Ideas]]" },
        { name: "MyVault/Ideas.md", data: "# Ideas" },
      ],
      expect: { source: "obsidian", notes: { "Daily/2026-10-24.md": "# Today\n\nsee [[Ideas]]", "Ideas.md": "# Ideas" } },
    },
    {
      name: "Export.zip",
      files: [
        { name: `Export/Home ${id}.md`, data: `# Home\n\n[Projects](Projects%20${id}.md)` },
        { name: `Export/Projects ${id}.md`, data: "# Projects" },
      ],
      expect: { source: "notion", notes: { "Home.md": null, "Projects.md": "# Projects" } },
    },
  ];
  for (const a of archives) {
    const bytes = await zip(a.files);
    const chooser = page.waitForEvent("filechooser");
    await runCmd(page, "vault.import");
    const pick = page.getByRole("dialog").filter({ has: page.locator("select") });
    await expect(pick).toBeVisible({ timeout: 10_000 });
    await pick.locator("select").selectOption("zip");
    await pick.getByRole("button", { name: /^(OK|Confirm)$/i }).click();
    await (await chooser).setFiles({ name: a.name, mimeType: "application/zip", buffer: Buffer.from(bytes) });
    const toast = page.getByText(new RegExp(`Imported ${Object.keys(a.expect.notes).length} notes .*\\(${a.expect.source}\\)`));
    await expect(toast).toBeVisible({ timeout: 15_000 });
    const folder = (await toast.textContent())!.match(/into “([^”]+)”/)![1];
    for (const [path, text] of Object.entries(a.expect.notes)) {
      const got = await vaultText(page, `${folder}/${path}`);
      expect(got, `${folder}/${path}`).not.toBeNull();
      if (text !== null) expect(got).toBe(text);
    }
    if (a.expect.source === "notion") expect(await vaultText(page, `${folder}/Home.md`)).toContain("Projects.md");
  }
});
