import { test, expect, type Page } from "@playwright/test";
import { opfsWritable, vaultOrSkip } from "./_opfs";

/**
 * Plan W2.1: the vault organizer writes nothing without approval. It reads
 * the workspace, suggests links (here: two notes mentioned but not
 * linked), and sends them to the review screen; the note changes only for
 * the suggestion the user approves.
 */

const NOTES: Record<string, string> = {
  "Project Aurora.md": "# Project Aurora\n\nThe launch.\n",
  "Hiring Plan.md": "# Hiring Plan\n\nWho we hire.\n",
  "meeting.md": "# Meeting\n\nWe discussed Project Aurora and the Hiring Plan today.\n",
};

async function opfs(page: Page, op: "write" | "read" | "all", path = "", text = ""): Promise<string | Record<string, string> | null> {
  return page.evaluate(
    async ({ op, path, text }) => {
      const root = await navigator.storage.getDirectory();
      if (op === "all") {
        const out: Record<string, string> = {};
        const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
          for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
            const p = prefix ? `${prefix}/${name}` : name;
            if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, p);
            else out[p] = await (await (h as FileSystemFileHandle).getFile()).text();
          }
        };
        await walk(root, "");
        return out;
      }
      const parts = path.split("/");
      const file = parts.pop()!;
      let dir = root;
      try {
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: op === "write" });
        if (op === "read") return await (await (await dir.getFileHandle(file)).getFile()).text();
        const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
        await w.write(text);
        await w.close();
        return text;
      } catch {
        return null;
      }
    },
    { op, path, text },
  ) as Promise<string | Record<string, string> | null>;
}

test.beforeEach(async ({ page, browserName }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  vaultOrSkip(await opfsWritable(page), browserName);
  for (const [p, t] of Object.entries(NOTES)) await opfs(page, "write", p, t);
});

test("organizer suggestions wait in the review screen; only the approved one is written", async ({ page }) => {
  const before = (await opfs(page, "all")) as Record<string, string>;

  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("Organize the vault");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("organizer-panel");
  await expect(panel).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
  await expect(panel.getByTestId("organizer-suggestion").filter({ hasText: "“Project Aurora” is mentioned in meeting but not linked" })).toHaveCount(1);
  await expect(panel.getByTestId("organizer-confidence").first()).toHaveText(/^\d+%$/);
  // Analysis wrote nothing.
  expect(await opfs(page, "all")).toEqual(before);

  await panel.getByTestId("organizer-next").click();
  const review = page.getByTestId("agent-review-panel");
  await expect(review).toBeVisible();
  const cards = review.locator('[data-testid^="agent-change-"][data-status]');
  const aurora = cards.filter({ hasText: "“Project Aurora” is mentioned" });
  const hiring = cards.filter({ hasText: "“Hiring Plan” is mentioned" });
  await expect(aurora).toHaveAttribute("data-status", "pending");
  await expect(hiring).toHaveAttribute("data-status", "pending");
  // Staged, still not written.
  expect(await opfs(page, "all")).toEqual(before);

  await hiring.getByTestId("agent-change-reject").click();
  await expect(hiring).toHaveAttribute("data-status", "rejected");
  await aurora.getByTestId("agent-change-approve").click();
  await expect(aurora).toHaveAttribute("data-status", "applied");
  await expect.poll(() => opfs(page, "read", "meeting.md")).toBe("# Meeting\n\nWe discussed [[Project Aurora]] and the Hiring Plan today.\n");
  const after = (await opfs(page, "all")) as Record<string, string>;
  // Exactly one file changed.
  expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual(["meeting.md"]);
});
