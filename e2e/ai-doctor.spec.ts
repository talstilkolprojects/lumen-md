import { test, expect } from "@playwright/test";

/**
 * T21 — the AI doctor opens from the palette, runs its checks and shows a
 * fix for whatever is missing. CI has no Ollama, so the Ollama check must
 * fail *with the install command*, and the page must stay error-free.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("AI doctor: opens, checks, and names the fix when Ollama is missing", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("AI: Doctor");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Doctor/i, { timeout: 8000 });
  await page.keyboard.press("Enter");

  const doctor = page.locator('[role="dialog"][aria-label="AI doctor"]');
  await expect(doctor).toBeVisible({ timeout: 10_000 });
  // The checks finish within the probe timeouts.
  await expect(doctor.getByTestId("doctor-summary")).toBeVisible({ timeout: 20_000 });
  await expect(doctor.getByTestId("doctor-policy")).toHaveAttribute("data-status", "ok");

  // No Ollama on the CI runner: the finding fails and carries the command.
  const ollama = doctor.locator('[data-testid^="doctor-ollama"]').first();
  await expect(ollama).toBeVisible();
  const status = await ollama.getAttribute("data-status");
  if (status !== "ok") {
    await expect(ollama).toContainText("ollama");
    await expect(ollama.locator("pre")).toContainText(/ollama (serve|pull)|OLLAMA_ORIGINS/);
  }
  // An executor verdict is always present.
  await expect(doctor.getByTestId("doctor-executor")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(doctor).toBeHidden({ timeout: 5000 });
  expect(pageErrors).toEqual([]);
});

test("AI doctor on an empty machine: every row that is not OK names a fix (plan 7.4)", async ({ page }) => {
  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("AI: Doctor");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Doctor/i, { timeout: 8000 });
  await page.keyboard.press("Enter");
  const doctor = page.locator('[role="dialog"][aria-label="AI doctor"]');
  await expect(doctor.getByTestId("doctor-summary")).toBeVisible({ timeout: 20_000 });
  // The stage-6 engines are listed, with their own strings (not raw keys).
  for (const id of ["csp.local", "engines.host", "engines.translate", "engines.spellEn", "engines.spellHe", "engines.nikud", "engines.caption"]) {
    await expect(doctor.getByTestId(`doctor-${id}`), id).toBeVisible();
  }
  await expect(doctor.getByTestId("doctor-engines.translate")).not.toContainText("ai.doctor.check");
  // The production CSP allows the local services.
  await expect(doctor.getByTestId("doctor-csp.local")).toHaveAttribute("data-status", "ok");
  // English spelling works on the device with nothing downloaded.
  await expect(doctor.getByTestId("doctor-engines.spellEn")).toHaveAttribute("data-status", "ok");
  // Every warn / fail row (except the informational WebAssembly-threads one) carries a fix.
  const rows = doctor.locator('section[data-testid^="doctor-"]');
  const n = await rows.count();
  const bare: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    const id = (await r.getAttribute("data-testid")) ?? "";
    const status = await r.getAttribute("data-status");
    if ((status === "warn" || status === "fail") && id !== "doctor-wasm") {
      if ((await r.getByTestId("doctor-fix").count()) === 0) bare.push(id);
    }
  }
  expect(bare).toEqual([]);
});

