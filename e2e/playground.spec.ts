import { test, expect } from "@playwright/test";

/**
 * Web Playground: a multi-file React project and a Vue project run in the
 * sandboxed runner frame, with console output reported back, under the
 * production headers (the runner has its own CSP).
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

async function setDoc(page: import("@playwright/test").Page, text: string) {
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill(text);
}

test("runs a multi-file React project with JSX and TypeScript", async ({ page }) => {
  await setDoc(
    page,
    [
      "```playground react",
      "--- App.tsx ---",
      'import { useState } from "react";',
      "export default function App({ start }: { start: number }) {",
      "  const [n, setN] = useState<number>(start);",
      '  return <button id="b" onClick={() => setN(n + 1)}>Clicked {n}</button>;',
      "}",
      "--- main.jsx ---",
      'import { createRoot } from "react-dom/client";',
      'import App from "./App";',
      'console.log("mounted", 6 * 7);',
      'createRoot(document.getElementById("root")).render(<App start={3} />);',
      "--- style.css ---",
      "button { color: rgb(200, 0, 0); }",
      "```",
      "",
    ].join("\n"),
  );
  const block = page.locator('[data-testid="playground"]');
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Run" }).click();
  const frame = block.frameLocator("iframe");
  const button = frame.locator("#b");
  await expect(button).toHaveText("Clicked 3", { timeout: 30_000 });
  await button.click();
  await expect(button).toHaveText("Clicked 4");
  await expect(button).toHaveCSS("color", "rgb(200, 0, 0)");
  await block.getByRole("tab", { name: /Console/ }).click();
  await expect(block.getByRole("log")).toContainText("mounted 42");
  await expect(block).toHaveAttribute("data-state", "success");
});

test("runs Vue with its template compiler, and reports errors", async ({ page }) => {
  await setDoc(
    page,
    [
      "```playground vue",
      "--- main.js ---",
      'import { createApp, ref } from "vue";',
      'createApp({ setup() { const n = ref(5); return { n }; }, template: `<p id="v">n is {{ n * 2 }}</p>` }).mount("#app");',
      "```",
      "",
      "```playground",
      'import "./missing.js";',
      "```",
      "",
    ].join("\n"),
  );
  const [vue, broken] = [page.locator('[data-testid="playground"]').nth(0), page.locator('[data-testid="playground"]').nth(1)];
  await vue.getByRole("button", { name: "Run" }).click();
  await expect(vue.frameLocator("iframe").locator("#v")).toHaveText("n is 10", { timeout: 30_000 });
  await broken.getByRole("button", { name: "Run" }).click();
  await expect(broken).toHaveAttribute("data-state", "error", { timeout: 30_000 });
  await broken.getByRole("tab", { name: /Console/ }).click();
  await expect(broken.getByRole("log")).toContainText('can\'t find "./missing.js"');
});

test("the runner can't reach the app's storage", async ({ page }) => {
  await setDoc(
    page,
    [
      "```playground",
      "let r;",
      'try { r = typeof localStorage.getItem("lumen-md"); } catch (e) { r = "blocked: " + e.name; }',
      'console.log("storage", r, "origin", String(window.origin));',
      "```",
      "",
    ].join("\n"),
  );
  const block = page.locator('[data-testid="playground"]');
  await block.getByRole("button", { name: "Run" }).click();
  await block.getByRole("tab", { name: /Console/ }).click();
  await expect(block.getByRole("log")).toContainText("storage blocked: SecurityError origin null", { timeout: 30_000 });
});

test("the runner runs under its own CSP with no script blocked (WebKit: by nonce)", async ({ page }) => {
  // In every frame, the sandboxed runner included: record CSP violations.
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __cspv?: string[] };
      (w.__cspv ??= []).push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  await page.reload();
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await setDoc(
    page,
    [
      "```playground react",
      "--- main.jsx ---",
      'import { createRoot } from "react-dom/client";',
      'createRoot(document.getElementById("root")).render(<p id="r">react ok</p>);',
      "```",
      "",
      "```playground vue",
      "--- main.js ---",
      'import { createApp } from "vue";',
      'createApp({ template: `<p id="v">vue ok</p>` }).mount("#app");',
      "```",
      "",
    ].join("\n"),
  );
  const [react, vue] = [page.locator('[data-testid="playground"]').nth(0), page.locator('[data-testid="playground"]').nth(1)];
  await react.getByRole("button", { name: "Run" }).click();
  await expect(react.frameLocator("iframe").locator("#r")).toHaveText("react ok", { timeout: 30_000 });
  await vue.getByRole("button", { name: "Run" }).click();
  await expect(vue.frameLocator("iframe").locator("#v")).toHaveText("vue ok", { timeout: 30_000 });

  const runners = page.frames().filter((f) => f.url().includes("playground-runner.html"));
  expect(runners.length).toBeGreaterThan(0);
  for (const frame of runners) {
    // The policy is enforced here (the meta copy in dev, plus the header in production) ...
    const csp = await frame.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "");
    expect(csp).toContain("'nonce-lumen-livejs-runner'");
    // ... and no script (entry, chunks, vendor React, Vue, blob: modules) was blocked by it.
    // Other directives are not asserted: the dev server's HMR socket is outside connect-src.
    const blocked = await frame.evaluate(() => (window as unknown as { __cspv?: string[] }).__cspv ?? []);
    expect(blocked.filter((v) => v.startsWith("script-src"))).toEqual([]);
  }
});
