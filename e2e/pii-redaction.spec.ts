import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Plan 2.6 — personal data never reaches the cloud provider. Every pattern
 * item of the PII golden set's dev split (e-mail, phone, ID, card, IBAN,
 * plate, birth date) goes into a note; an AI command sends the note to a
 * cloud provider under the `cloud` policy; every request that reaches the
 * provider is captured, and none of the set's values is in it. The answer
 * comes back with the values restored.
 */

const PATTERN = new Set(["EMAIL", "PHONE", "IL_ID", "CREDIT_CARD", "IBAN", "LICENSE_PLATE", "DATE_OF_BIRTH"]);
const set = JSON.parse(readFileSync(fileURLToPath(new URL("../eval/golden/ner-pii/dev/synthetic.json", import.meta.url)), "utf8")) as {
  items: Array<{ text: string; kind: string; entities: Array<{ type: string; text: string }> }>;
};
const positives = set.items.filter((i) => i.kind === "positive" && i.entities.some((e) => PATTERN.has(e.type)));
const values = positives.flatMap((i) => i.entities.filter((e) => PATTERN.has(e.type)).map((e) => e.text));
const NOTE = ["# פגישה", "", ...positives.map((i) => `- ${i.text}`), ""].join("\n");

async function loadNote(page: Page) {
  await page.keyboard.press("Meta+1"); // source
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.press("ControlOrMeta+a");
  await source.fill(NOTE);
}

test("cloud policy: the provider receives tokens, never the golden set's values; the answer is restored", async ({ page }) => {
  expect(values.length).toBeGreaterThanOrEqual(20);
  const bodies: string[] = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const body = route.request().postData() ?? "";
    bodies.push(body);
    // Echo back the first phone token, as a model answering about it would.
    const token = body.match(/⟨PHONE_\d+⟩/)?.[0] ?? "none";
    return route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ type: "text", text: `- [ ] לחזור אל ${token}` }], usage: { input_tokens: 1, output_tokens: 1 } }),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "cloud");
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "sk-ant-e2e");
    localStorage.setItem("lumen.ai.cache", "off");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await loadNote(page);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.actionItems" } })));
  await expect.poll(() => bodies.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator(".cm-content").first()).toContainText("Action Items", { timeout: 20_000 });

  const sent = bodies.join("\n");
  const leaked = values.filter((v) => sent.includes(v));
  expect(leaked).toEqual([]);
  expect(sent).toMatch(/⟨(EMAIL|PHONE|IL_ID|CREDIT_CARD|IBAN|LICENSE_PLATE|DATE_OF_BIRTH)_\d+⟩/);
  // The answer's token is back as the original phone number, in the note.
  const firstPhone = positives.flatMap((i) => i.entities).find((e) => e.type === "PHONE")!.text;
  await expect(page.locator(".cm-content").first()).toContainText(`לחזור אל ${firstPhone}`);

  // The ledger shows how many were hidden, never the values.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.privacyLedger" } })));
  const panel = page.locator('[role="dialog"][aria-label="Privacy ledger"]');
  await expect(panel.getByTestId("privacy-redacted")).toContainText(String(values.length));
  await expect(panel).not.toContainText(firstPhone);
});

test("local-only: nothing reaches a cloud provider at all", async ({ page }) => {
  let reached = 0;
  await page.route("https://api.anthropic.com/**", (route) => {
    reached++;
    return route.fulfill({ status: 200, body: "{}" });
  });
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "sk-ant-e2e");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await loadNote(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.actionItems" } })));
  // The agent run is over (answered locally or failed for want of a local
  // model): every run ends in the agent trace, so by then any cloud request
  // would have been made.
  await expect.poll(() => tracedRuns(page), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(reached).toBe(0);
});

/** Finished agent runs in the trace (idb-keyval's store, key lumen-agent-trace); 0 until it exists. */
async function tracedRuns(page: Page): Promise<number> {
  return page.evaluate(async () => {
    // Opening a database that does not exist yet would create it without
    // idb-keyval's object store: only look once the app has created it.
    if (!(await indexedDB.databases()).some((d) => d.name === "keyval-store")) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open("keyval-store");
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("keyval")) {
          db.close();
          resolve(0);
          return;
        }
        const get = db.transaction("keyval", "readonly").objectStore("keyval").get("lumen-agent-trace");
        get.onsuccess = () => {
          db.close();
          const runs = get.result as Array<{ endedAt?: number }> | undefined;
          resolve(Array.isArray(runs) ? runs.filter((r) => typeof r.endedAt === "number").length : 0);
        };
        get.onerror = () => {
          db.close();
          resolve(0);
        };
      };
    });
  });
}
