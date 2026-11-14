import { test, expect, type Route } from "@playwright/test";

/**
 * Plan 6.9 — local autocomplete: typing asks the local Ollama
 * (`/api/generate` with `suffix`), the grey completion appears at the
 * cursor, Tab accepts it. The Ollama here is scripted on localhost; no
 * request goes anywhere else.
 */
test("local FIM: a completion from the local Ollama appears while typing; Tab accepts it", async ({ page }) => {
  const CLOUD = /^https:\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.languagetool\.org)\//;
  const offDevice: string[] = [];
  page.on("request", (r) => {
    if (CLOUD.test(r.url())) offDevice.push(r.url());
  });
  const bodies: Array<{ model: string; prompt: string; suffix: string }> = [];
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):11434\/api\/(tags|version|show)/, (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/tags")) return route.fulfill({ json: { models: [{ name: "qwen2.5-coder:1.5b" }, { name: "qwen2.5-coder:3b" }] } });
    if (path.endsWith("/version")) return route.fulfill({ json: { version: "0.6.0" } });
    return route.fulfill({ json: { capabilities: ["completion", "insert"] } });
  });
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):11434\/api\/generate/, (route: Route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { response: "jumps over the lazy dog.", done: true, prompt_eval_count: 12, eval_count: 6 } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem("lumen.fim.enabled", "1");
  });
  await page.goto("/");
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await editor.fill("");
  await page.keyboard.type("The quick brown fox ");

  const ghost = page.locator(".cm-ai-suggestion");
  await expect(ghost).toHaveText("jumps over the lazy dog.", { timeout: 10_000 });
  expect(bodies.at(-1)).toMatchObject({ model: "qwen2.5-coder:1.5b", prompt: "The quick brown fox ", suffix: "" });

  await page.keyboard.press("Tab");
  await expect(editor).toContainText("The quick brown fox jumps over the lazy dog.");
  await expect(ghost).toHaveCount(0);

  // Typing again cancels, then asks again; Escape dismisses.
  await page.keyboard.type(" Then");
  await expect(ghost).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(ghost).toHaveCount(0);
  expect(offDevice).toEqual([]);
});
