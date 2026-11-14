import { test, expect, type Page } from "@playwright/test";
import { opfsWritable, vaultOrSkip } from "./_opfs";

/**
 * Plan W2.3: a change an MCP client proposes is not saved without the
 * user's approval. The vault's MCP server writes proposals to
 * `.lumen/mcp/pending/<id>.json` (mcp-server/src/vault/pending.ts — the
 * same files this spec puts in the workspace); the app stages them in the
 * review panel, writes a note only on Approve, and records each decision
 * in `.lumen/mcp/ledger.jsonl`. No test surface is used.
 */

const NOTE = "projects/plan.md";
const NOTE_TEXT = "# Plan\n\nKeep this line.\n";

async function opfs(page: Page, op: "write" | "read" | "list", path: string, text = ""): Promise<string | string[] | null> {
  return page.evaluate(
    async ({ op, path, text }) => {
      const parts = path.split("/").filter(Boolean);
      let dir = await navigator.storage.getDirectory();
      if (op === "list") {
        try {
          for (const p of parts) dir = await dir.getDirectoryHandle(p);
        } catch {
          return [];
        }
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
        return names.sort();
      }
      const file = parts.pop()!;
      try {
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: op === "write" });
        if (op === "read") return await (await (await dir.getFileHandle(file)).getFile()).text();
        const h = await dir.getFileHandle(file, { create: true });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        return text;
      } catch {
        return null;
      }
    },
    { op, path, text },
  ) as Promise<string | string[] | null>;
}

function proposal(id: string, path: string, before: string | null, after: string, tool: string) {
  return JSON.stringify({ id, client: "claude-desktop", tool, path, before, after, createdAt: "2026-11-10T09:00:00.000Z" });
}

test.beforeEach(async ({ page, browserName }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  // The workspace is OPFS; Playwright's Linux WebKit build has none (the app then has no vault to import into).
  vaultOrSkip(await opfsWritable(page), browserName);
});

test("an MCP client's proposals wait in the review panel; only the approved one is written", async ({ page }) => {
  await opfs(page, "write", NOTE, NOTE_TEXT);
  await opfs(page, "write", ".lumen/mcp/pending/mcpe2enew0001.json", proposal("mcpe2enew0001", "inbox/idea.md", null, "# Idea from Claude\n", "create_note"));
  await opfs(page, "write", ".lumen/mcp/pending/mcpe2eapp0002.json", proposal("mcpe2eapp0002", NOTE, NOTE_TEXT, NOTE_TEXT + "- appended by the client\n", "append_note"));
  // The inbox reads the folder on focus (and every few seconds).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(page.getByTestId("status-agent-review")).toContainText("Review 2", { timeout: 15_000 });
  // Nothing written yet.
  expect(await opfs(page, "read", "inbox/idea.md")).toBeNull();
  expect(await opfs(page, "read", NOTE)).toBe(NOTE_TEXT);

  await page.getByTestId("status-agent-review").click();
  const panel = page.getByTestId("agent-review-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Proposed by claude-desktop (MCP client)");
  const cards = panel.locator('[data-testid^="agent-change-"][data-status]');
  const created = cards.filter({ hasText: "inbox/idea.md" });
  const appended = cards.filter({ hasText: NOTE }).filter({ hasNotText: "inbox/idea.md" });
  await expect(created).toHaveAttribute("data-status", "pending");
  await expect(appended).toHaveAttribute("data-status", "pending");

  await appended.getByTestId("agent-change-reject").click();
  await expect(appended).toHaveAttribute("data-status", "rejected");
  await created.getByTestId("agent-change-approve").click();
  await expect(created).toHaveAttribute("data-status", "applied");

  await expect.poll(() => opfs(page, "read", "inbox/idea.md")).toBe("# Idea from Claude\n");
  expect(await opfs(page, "read", NOTE)).toBe(NOTE_TEXT);
  // Both proposals settled: removed from the queue, decisions in the ledger.
  await expect.poll(() => opfs(page, "list", ".lumen/mcp/pending")).toEqual([]);
  await expect.poll(async () => String(await opfs(page, "read", ".lumen/mcp/ledger.jsonl")).trim().split("\n").length).toBe(2);
  const ledger = String(await opfs(page, "read", ".lumen/mcp/ledger.jsonl"));
  expect(ledger).toContain('"decision":"rejected"');
  expect(ledger).toContain('"decision":"approved"');
  expect(ledger).not.toContain("appended by the client");
});

test("a proposal for a path outside the vault or in .lumen is ignored", async ({ page }) => {
  await opfs(page, "write", ".lumen/mcp/pending/mcpe2ebad0003.json", proposal("mcpe2ebad0003", ".lumen/mcp.json", null, "{}", "write_note"));
  await opfs(page, "write", ".lumen/mcp/pending/mcpe2ebad0004.json", proposal("mcpe2ebad0004", "../escape.md", null, "x", "write_note"));
  await opfs(page, "write", ".lumen/mcp/pending/mcpe2eok00005.json", proposal("mcpe2eok00005", "ok.md", null, "fine\n", "create_note"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("status-agent-review")).toContainText("Review 1", { timeout: 15_000 });
  await page.getByTestId("status-agent-review").click();
  await expect(page.getByTestId("agent-review-panel")).toContainText("ok.md");
  await expect(page.getByTestId("agent-review-panel")).not.toContainText("escape.md");
});
