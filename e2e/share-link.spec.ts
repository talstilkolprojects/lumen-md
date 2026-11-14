import { test, expect, type Page, type Request } from "@playwright/test";
import { createShareLink } from "../src/share/linkShare";

/**
 * Plan W5.10 — an encrypted share link with no server.
 *
 *   1. A 20 KB note opens from its link in the read-only viewer (this spec
 *      runs in the chromium, firefox and webkit projects: Chrome, Firefox and
 *      Safari's engine).
 *   2. No request the browser sends — URL, headers (Referer included) or
 *      body, from the page or any worker — holds a byte of the note, of the
 *      encrypted data or of the key: they live in the #fragment.
 *   3. The share dialog makes a link from the open note, and that link opens.
 */

const MARKER = "W510-secret-marker-שלום";

/** A 20 KB note (Hebrew and English) that carries a marker to look for. */
function note20k(): string {
  let s = `# ${MARKER}\n\n`;
  for (let i = 0; s.length < 20 * 1024; i++) s += `פסקה ${i}: שלום עולם, paragraph ${i} with **bold** text and a list.\n\n- one ${i}\n- two\n\n`;
  return s.slice(0, 20 * 1024);
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Every request of the context (pages and their workers), with headers and body. */
function recordRequests(page: Page): Seen[] {
  const seen: Seen[] = [];
  const pending: Promise<void>[] = [];
  page.context().on("request", (r: Request) => {
    pending.push(
      r.allHeaders().then((headers) => {
        seen.push({ url: r.url(), headers, body: r.postData() ?? "" });
      }),
    );
  });
  (seen as Seen[] & { settle?: () => Promise<void> }).settle = () => Promise.all(pending).then(() => undefined);
  return seen;
}

async function expectNothingLeaks(seen: Seen[], secrets: string[]) {
  await (seen as Seen[] & { settle?: () => Promise<void> }).settle?.();
  expect(seen.length).toBeGreaterThan(0);
  for (const r of seen) {
    const all = [r.url, ...Object.values(r.headers), r.body].join("\n");
    for (const s of secrets) {
      for (const form of [s, encodeURIComponent(s)]) expect(all.includes(form), `${r.url} carries ${s.slice(0, 16)}…`).toBe(false);
    }
    // The fragment never travels: no request URL or Referer holds a "#".
    expect(r.url.includes("#view"), r.url).toBe(false);
    expect((r.headers.referer ?? "").includes("#"), r.headers.referer).toBe(false);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
  });
});

test("a 20 KB note opens from its link, and no request carries the note or its key", async ({ page, baseURL }) => {
  const markdown = note20k();
  const link = await createShareLink({ title: "פגישה.md", markdown, created: Date.now() }, new URL(baseURL!).origin);
  expect(link.url).not.toBeNull();
  const hash = new URL(link.url!).hash;
  const data = /view=([^&]+)/.exec(hash)![1];

  const seen = recordRequests(page);
  await page.goto(link.url!);
  const viewer = page.getByTestId("shared-note");
  await expect(viewer.locator(".prose-lumen h1")).toHaveText(MARKER, { timeout: 15_000 });
  await expect(viewer.getByTestId("shared-note-badge")).toBeVisible();
  // The last paragraph rendered too: the whole 20 KB arrived.
  const tail = markdown.trim().split("\n").filter((l) => l.startsWith("פסקה")).pop()!.slice(0, 20);
  await expect(viewer.getByText(tail, { exact: false }).first()).toBeAttached();
  // Read-only: no editor on the page.
  await expect(page.locator(".cm-content")).toHaveCount(0);
  await page.waitForLoadState("networkidle").catch(() => {
    /* why: a settle step for late requests; the dev server's page may never idle */
  });
  await expectNothingLeaks(seen, [link.key, data, data.slice(0, 64), data.slice(-64), MARKER, "W510-secret-marker", "פגישה.md"]);
});

test("a link without its key asks for it; a wrong key and an expired note are refused", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const link = await createShareLink({ title: "t", markdown: `# ${MARKER}`, created: Date.now() }, origin);
  await page.goto(link.urlWithoutKey!);
  await page.getByTestId("shared-note-key").fill(link.key);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator(".prose-lumen h1")).toHaveText(MARKER);

  const other = await createShareLink({ title: "t", markdown: "x", created: 1 }, origin);
  await page.goto(`${link.urlWithoutKey}&key=${other.key}`);
  await expect(page.getByTestId("shared-note-error")).toHaveAttribute("data-code", "key");

  const old = await createShareLink({ title: "t", markdown: "expired text", created: 1, expires: 2 }, origin);
  await page.goto(old.url!);
  await expect(page.getByTestId("shared-note-error")).toHaveAttribute("data-code", "expired");
  await expect(page.getByText("expired text")).toHaveCount(0);
});

test("the share dialog makes a link from the open note, and the link opens it", async ({ page, context }) => {
  const seen = recordRequests(page);
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await editor.fill(`# ${MARKER}\n\nshared from the dialog`);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("Share as encrypted link");
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("share-link");
  await dialog.getByTestId("share-link-create").click();
  const url = await dialog.getByTestId("share-link-url").inputValue();
  expect(new URL(url).pathname).toBe("/");
  expect(new URL(url).search).toBe("");
  expect(new URL(url).hash).toMatch(/^#view=[A-Za-z0-9_-]+&key=[A-Za-z0-9_-]{43}$/);
  await expectNothingLeaks(seen, [MARKER, "shared from the dialog", /key=([^&]+)/.exec(url)![1]]);

  const viewer = await context.newPage();
  await viewer.goto(url);
  await expect(viewer.locator(".prose-lumen h1")).toHaveText(MARKER, { timeout: 15_000 });
  await expect(viewer.getByText("shared from the dialog")).toBeVisible();
});
