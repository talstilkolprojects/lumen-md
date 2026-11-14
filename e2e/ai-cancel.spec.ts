import { test, expect } from "@playwright/test";

/**
 * 1.4 / T55 — Esc cancels a running AI command. A fake Ollama answers its
 * probes but never finishes the chat request; Esc must abort that request,
 * say so, and leave the note unchanged.
 */
test("Esc cancels a running AI command: the request is aborted and nothing is inserted", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  let chatStarted = false;
  const aborted: string[] = [];
  page.on("requestfailed", (r) => {
    if (/11434\/(api\/chat|api\/generate|v1\/chat\/completions)/.test(r.url())) aborted.push(r.failure()?.errorText ?? "");
  });
  await page.route(/https?:\/\/(localhost|127\.0\.0\.1):11434\/.*/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/tags") {
      return route.fulfill({ json: { models: [{ name: "qwen2.5:7b", size: 1, digest: "abcdef1234567890", modified_at: "t", details: { family: "qwen2", parameter_size: "7B" } }] } });
    }
    if (path === "/api/version") return route.fulfill({ json: { version: "0.12.0" } });
    if (path === "/api/show") return route.fulfill({ json: { capabilities: ["completion", "tools"], details: { family: "qwen2" } } });
    if (/\/(api\/chat|api\/generate|v1\/chat\/completions)$/.test(path)) {
      chatStarted = true;
      return; // never answer: only a cancel ends this request
    }
    return route.fulfill({ status: 404, body: "" });
  });
  // No model downloads in this test: a fallback to the browser model would fail loudly here.
  await page.route(/huggingface\.co|hf\.co/, (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("Welcome to", { timeout: 15_000 });
  const before = await editor.innerText();

  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("AI: Extract Action Items");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Action Items/i, { timeout: 8000 });
  await page.keyboard.press("Enter");

  await expect.poll(() => chatStarted, { timeout: 20_000 }).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByText(/AI request cancelled \(\d+\)/)).toBeVisible({ timeout: 5000 });
  await expect.poll(() => aborted.length, { timeout: 5000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(await editor.innerText()).toBe(before);
  expect(await editor.innerText()).not.toContain("Action Items");
  expect(pageErrors).toEqual([]);
});
