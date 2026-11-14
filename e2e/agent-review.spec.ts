import { test, expect, type Page } from "@playwright/test";

/**
 * Plan 5.11: changes agents propose wait for the user in the review panel.
 *
 * The proposal is staged through the app's test surface exactly as an
 * agent's write tool stages it (`window.__lumen.agentReview.stage`, which
 * also records the open document's fingerprint like the runtime does): no
 * shipped command grants agents the write scope yet (plan 5.3 wires the
 * agents to their tools), so a real run cannot propose a change in the
 * browser. The runtime → staging path is covered by vitest
 * (agentReviewApply.test.ts, agentToolPermissions.test.ts).
 */

interface Surface {
  agentReview: {
    stage: (proposal: unknown, meta?: { runId?: string; agentId?: string }) => Promise<string>;
    withdrawRun: (runId: string) => Promise<number>;
  };
}

const DOC = "Hello wrld, from the agent test.\n";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await page.waitForFunction(() => !!(window as unknown as { __lumen?: Partial<Surface> }).__lumen?.agentReview);
});

/** Replace the open (unsaved) document's text in the source editor. */
async function typeDocument(page: Page, text: string) {
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.press("ControlOrMeta+a");
  await source.fill(text);
  await expect(source).toContainText(text.trim());
}

/** What proofreader's replace_range would stage for "wrld" → "world" in DOC. */
async function proposeTypoFix(page: Page, runId = "run_e2e") {
  return page.evaluate(
    ({ runId }) =>
      (window as unknown as { __lumen: Surface }).__lumen.agentReview.stage(
        { kind: "range", path: null, from: 6, to: 10, before: "wrld", after: "world", summary: "Fix a typo: wrld → world" },
        { runId, agentId: "proofreader" },
      ),
    { runId },
  );
}

test("an agent's change waits for approval; approving applies it to the unsaved document, and Undo takes it back", async ({ page }) => {
  await typeDocument(page, DOC);
  const id = await proposeTypoFix(page);

  // Announced (toast + status-bar badge), not applied.
  await expect(page.getByTestId("status-agent-review")).toContainText("Review 1");
  const toastButton = page.getByTestId("toast-action");
  await expect(toastButton).toBeVisible();
  const source = page.locator(".cm-content").first();
  // Staged, not applied: the proposal is in the review queue (the badge above
  // counts it) and the document still holds the original text.
  await expect.poll(() => page.evaluate(() => document.querySelector(".cm-content")?.textContent ?? "")).toContain("Hello wrld,");
  await expect(source).toContainText("Hello wrld,");

  await toastButton.click();
  const panel = page.getByTestId("agent-review-panel");
  await expect(panel).toBeVisible();
  const card = panel.getByTestId(`agent-change-${id}`);
  await expect(card).toHaveAttribute("data-status", "pending");
  await expect(panel).toContainText("Proposed by proofreader");
  await expect(card.locator("del")).toHaveText("wrld");
  await expect(card.locator("ins")).toHaveText("world");
  await expect(source).toContainText("Hello wrld,"); // still nothing written

  await card.getByTestId("agent-change-approve").click();
  await expect(card).toHaveAttribute("data-status", "applied");
  await expect(card.getByTestId("agent-change-outcome")).toContainText("Applied in the editor, not saved yet");
  await expect(source).toContainText("Hello world, from the agent test.");
  await expect(page.getByTestId("status-agent-review")).toHaveCount(0);

  // The approval went through CodeMirror: Undo takes it back.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await source.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(source).toContainText("Hello wrld, from the agent test.");
});

test("a change whose text was edited underneath is refused with an explanation (palette entry point)", async ({ page }) => {
  await typeDocument(page, DOC);
  const id = await proposeTypoFix(page);
  await typeDocument(page, "Completely different text now.\n");

  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("Review changes proposed by agents");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("agent-review-panel");
  await expect(panel).toBeVisible();

  const card = panel.getByTestId(`agent-change-${id}`);
  await card.getByTestId("agent-change-approve").click();
  await expect(card).toHaveAttribute("data-status", "conflict");
  await expect(card.getByTestId("agent-change-outcome")).toHaveText("Not applied: the text it changes was edited after the proposal.");
  await expect(page.locator(".cm-content").first()).toContainText("Completely different text now.");
});

test("cancelling the run withdraws its proposals from the open panel", async ({ page }) => {
  await typeDocument(page, DOC);
  const id = await proposeTypoFix(page, "run_cancelled");
  await page.getByTestId("status-agent-review").click();
  const card = page.getByTestId(`agent-change-${id}`);
  await expect(card).toHaveAttribute("data-status", "pending");

  await page.evaluate(() => (window as unknown as { __lumen: Surface }).__lumen.agentReview.withdrawRun("run_cancelled"));
  await expect(card).toHaveAttribute("data-status", "rejected");
  await expect(card.getByTestId("agent-change-outcome")).toHaveText("Withdrawn: the run was cancelled.");
  await expect(card.getByTestId("agent-change-approve")).toHaveCount(0);
  await expect(page.getByTestId("agent-review-empty")).toBeVisible();
  await expect(page.getByTestId("status-agent-review")).toHaveCount(0);
  await expect(page.locator(".cm-content").first()).toContainText("Hello wrld,");
});
