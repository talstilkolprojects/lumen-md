import { test, expect, type Route } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";

/**
 * Plan 5.8 — a local batch job pauses, survives a reload paused, resumes
 * from the notes still missing, and shows its progress live. The local
 * model is a scripted Ollama on localhost (routed here), whose answers the
 * test releases one at a time, so nothing depends on timing.
 */
test("batch: pause → reload → resume finishes the job; the panel shows progress", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  const held: Array<() => void> = [];
  let auto = false;
  let chats = 0;
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):11434\/api\/(tags|version|show)/, (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/tags")) return route.fulfill({ json: { models: [{ name: "qwen2.5:7b", details: { parameter_size: "7.6B", family: "qwen2" } }] } });
    if (path.endsWith("/version")) return route.fulfill({ json: { version: "0.6.0" } });
    return route.fulfill({ json: { capabilities: ["completion"] } });
  });
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):11434\/api\/chat/, async (route: Route) => {
    chats++;
    if (!auto) await new Promise<void>((resolve) => held.push(resolve));
    const message = { role: "assistant", content: "A short summary of the note." };
    // A note paused mid-answer was aborted by the page: fulfilling it then fails, harmlessly.
    await route.fulfill({ json: { message, done: true, prompt_eval_count: 10, eval_count: 8 } }).catch(() => {});
  });
  /** Answer the oldest held request. */
  const releaseOne = async () => {
    await expect.poll(() => held.length, { timeout: 15_000 }).toBeGreaterThan(0);
    held.shift()!();
  };

  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });

  const wrote = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("batch-e2e", { create: true });
      for (const [name, text] of [
        ["a.md", "# Alpha\n\nThe first note talks about apples and orchards in the north."],
        ["b.md", "# Beta\n\nThe second note is about bees, hives and honey."],
        ["c.md", "# Gamma\n\nThe third note covers garden tools and how to keep them."],
      ]) {
        const fh = (await dir.getFileHandle(name, { create: true })) as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
        if (typeof fh.createWritable !== "function") return false;
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      }
      return true;
    } catch {
      return false;
    }
  });
  vaultOrSkip(wrote, browserName);

  const run = (id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
  const prompt = page.locator(".prompt-backdrop");

  // Submit: summarise the three notes in batch-e2e/.
  await run("ai.batch");
  await prompt.locator("select").selectOption("summary");
  await prompt.locator(".prompt-btn-ok").click();
  await prompt.locator("input").fill("batch-e2e");
  await prompt.locator(".prompt-btn-ok").click();
  await expect(prompt).toContainText("qwen2.5:7b");
  await prompt.locator(".prompt-btn-ok").click();

  // The panel opens on its own and counts the notes live.
  const panel = page.locator('[role="dialog"][aria-label="Batch jobs"]');
  const row = panel.locator('[data-testid="batch-job"]');
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await expect(row.locator('[data-testid="batch-count"]')).toHaveText("0 of 3 done · 0 failed");
  await releaseOne();
  await expect(row.locator('[data-testid="batch-count"]')).toHaveText("1 of 3 done · 0 failed");
  await expect(row.locator('[data-testid="batch-status"]')).toContainText(/left/);

  // Pause while the second note is in flight.
  await expect.poll(() => held.length).toBe(1);
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row).toHaveAttribute("data-paused", "1");
  await expect(row.locator('[data-testid="batch-status"]')).toHaveText("Paused");

  // Reload: still paused, nothing runs, the count is kept.
  held.splice(0).forEach((r) => r());
  await page.reload();
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  await run("ai.batchJobs");
  await expect(row).toHaveAttribute("data-paused", "1", { timeout: 10_000 });
  await expect(row.locator('[data-testid="batch-count"]')).toHaveText("1 of 3 done · 0 failed");
  const chatsWhilePaused = chats;
  // "Check Batch Jobs" while paused leaves it paused.
  await page.keyboard.press("Escape");
  await run("ai.batchCheck");
  await run("ai.batchJobs");
  await expect(row).toHaveAttribute("data-paused", "1");
  expect(chats).toBe(chatsWhilePaused);

  // Resume: the two missing notes run, and the job finishes.
  auto = true;
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(row).toHaveAttribute("data-finished", "1", { timeout: 20_000 });
  await expect(row.locator('[data-testid="batch-count"]')).toHaveText("3 of 3 done · 0 failed");
  expect(chats - chatsWhilePaused).toBe(2);

  // Apply: each note gets its summary.
  await row.getByRole("button", { name: "Apply results" }).click();
  await expect(prompt).toContainText("3 notes to update");
  await prompt.locator(".prompt-btn-ok").click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle("batch-e2e");
          const out: string[] = [];
          for (const n of ["a.md", "b.md", "c.md"]) out.push(await (await (await dir.getFileHandle(n)).getFile()).text());
          return out.filter((t) => /^summary: "A short summary of the note\."/m.test(t)).length;
        }),
      { timeout: 10_000 },
    )
    .toBe(3);
});
