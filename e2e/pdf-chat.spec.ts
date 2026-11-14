import { test, expect, type Route } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";
import { readFileSync } from "node:fs";

/**
 * Plan 6.8 — ask a PDF on this device. The fixture (3 pages, English and
 * Hebrew) is put in the vault and opened in the reader; the question goes to
 * a scripted Ollama on localhost that answers from the numbered passages it
 * was given, quoting the one that holds "passage to highlight". The answer
 * shows its page and line, and a click opens that page.
 */
const FIXTURE = readFileSync(new URL("./fixtures/bilingual.pdf", import.meta.url)).toString("base64");

test("ask a PDF: the answer cites its page and line, and the citation opens the page", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  const cloud: string[] = [];
  page.on("request", (r) => {
    if (/^https:\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai)\//.test(r.url())) cloud.push(r.url());
  });
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):11434\/api\/(tags|version|show)/, (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/tags")) return route.fulfill({ json: { models: [{ name: "qwen2.5:7b", details: { parameter_size: "7.6B", family: "qwen2" } }] } });
    if (path.endsWith("/version")) return route.fulfill({ json: { version: "0.6.0" } });
    return route.fulfill({ json: { capabilities: ["completion"] } });
  });
  let sawPassages = "";
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):11434\/api\/chat/, (route: Route) => {
    const body = route.request().postDataJSON() as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    sawPassages = system;
    // The passage that holds the words, by its number.
    const parts = [...system.matchAll(/\[(\d+)\] \(page (\d+), lines [^)]*\)\n([\s\S]*?)(?=\n\n\[\d+\] \(page |$)/g)];
    const hit = parts.find((m) => /passage\s+to\s+highlight/.test(m[3]));
    const content = JSON.stringify(hit ? { answer: "It is the passage to highlight.", citations: [{ source: Number(hit[1]), quote: "passage to highlight" }] } : { answer: "", citations: [] });
    return route.fulfill({ json: { message: { role: "assistant", content }, done: true, prompt_eval_count: 50, eval_count: 20 } });
  });

  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  const stored = await page.evaluate(async (base64) => {
    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const root = await navigator.storage.getDirectory();
      const fh = (await root.getFileHandle("bilingual.pdf", { create: true })) as unknown as { createWritable?: () => Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }> };
      if (typeof fh.createWritable !== "function") return false;
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      return true;
    } catch {
      return false;
    }
  }, FIXTURE);
  vaultOrSkip(stored, browserName);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: "bilingual.pdf" } })));
  const reader = page.getByTestId("pdf-reader");
  await expect(reader).toHaveAttribute("data-page-count", "3", { timeout: 15_000 });
  await expect(reader).toHaveAttribute("data-current-page", "1");

  await page.getByTestId("pdf-ask").click();
  const panel = page.getByTestId("pdf-ask-panel");
  await expect(panel).toBeVisible();
  await page.getByTestId("pdf-ask-input").fill("Which passage should be highlighted?");
  await page.getByTestId("pdf-ask-submit").click();

  const answer = page.getByTestId("pdf-ask-answer");
  await expect(answer).toContainText("It is the passage to highlight.", { timeout: 30_000 });
  const cite = answer.locator('[data-testid="pdf-ask-citations"] button').first();
  await expect(cite).toHaveAttribute("data-page", "2");
  await expect(cite).toContainText(/Page 2, line \d+/);
  expect(sawPassages).toMatch(/\(page 2, lines \d+–\d+\)/);

  await cite.click();
  await expect(reader).toHaveAttribute("data-current-page", "2", { timeout: 10_000 });
  expect(cloud).toEqual([]);
});
