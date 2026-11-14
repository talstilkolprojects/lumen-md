import { test, expect, type Page } from "@playwright/test";
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

/**
 * 4.18 — publish to your own static site. Acceptance: a 50-note site is
 * deployed and checked in a browser. Here the "deploy" is the .zip target
 * (the GitHub Pages target is unit-tested against a fake API in
 * publishSite.test.ts): the zip is unpacked and served from a stub host,
 * and the site is checked page by page — navigation, links, search, RTL.
 */

const SITE = "https://site.example.com";

/** Minimal unzip (stored + deflate) — the zip comes from src/storage/zip.ts. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function seedVault(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const write = async (path: string, text: string) => {
        const parts = path.split("/");
        let dir = root;
        for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
        if (typeof h.createWritable !== "function") throw new Error("no createWritable");
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
      };
      await write("index.md", "# Garden\n\nStart at [[Note 1]] or [the first guide](guides/guide-1.md).");
      for (let i = 1; i <= 30; i++) await write(`notes/Note ${i}.md`, `# Note ${i}\n\nNext: [[Note ${(i % 30) + 1}]]. Topic ${i % 2 ? "apples" : "pears"}.`);
      for (let i = 1; i <= 10; i++) await write(`guides/guide-${i}.md`, `# Guide ${i}\n\nSee [the next guide](guide-${(i % 10) + 1}.md).`);
      for (let i = 1; i <= 9; i++) await write(`עברית/פתק ${i}.md`, `# פתק ${i}\n\nשלום עולם, מילה${i} ותפוחים.`);
      return true;
    } catch {
      return false;
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

test("a 50-note site: published as a .zip, served, and checked in the browser", async ({ page, context }) => {
  test.skip(!(await seedVault(page)), "this engine refuses OPFS writes here, so there is no vault to publish");
  const outside: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(page.url()).origin && !/^(data|blob):/.test(u.protocol)) outside.push(r.url());
  });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "file.publishSite" } })));
  const dialog = page.getByTestId("publish-site");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId("publish-notes").locator("input[type=checkbox]")).toHaveCount(50, { timeout: 10_000 });
  await dialog.getByTestId("publish-title").fill("My garden");
  await dialog.getByTestId("publish-target-zip").check();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByTestId("publish-go").click();
  const download = await downloadPromise;
  await expect(dialog.getByTestId("publish-result")).toContainText("50");
  // Building and packing the site sent nothing anywhere.
  expect(outside).toEqual([]);

  const files = unzip(readFileSync(await download.path()));
  expect([...files.keys()].filter((f) => f.endsWith(".html") && f !== "404.html")).toHaveLength(50);

  // Serve the site from a stub host and read it like a visitor.
  const site = await context.newPage();
  await site.route(`${SITE}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1)) || "index.html";
    const body = files.get(path);
    if (!body) return route.fulfill({ status: 404, body: files.get("404.html") ?? "" });
    const type = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/json";
    return route.fulfill({ status: 200, contentType: `${type}; charset=utf-8`, body });
  });
  await site.goto(`${SITE}/index.html`);
  await expect(site.locator("h1").first()).toHaveText("Garden");
  await expect(site.locator(".lumen-site-tree a")).toHaveCount(50);

  // Links: wiki link, then Markdown link, then the navigation.
  await site.locator("main a", { hasText: "Note 1" }).click();
  await expect(site).toHaveURL(`${SITE}/notes/Note%201.html`);
  await expect(site.locator("main h1")).toHaveText("Note 1");
  await site.locator("main a", { hasText: "Note 2" }).click();
  await expect(site.locator("main h1")).toHaveText("Note 2");
  await site.locator(".lumen-site-tree a", { hasText: "Guide 3" }).click();
  await expect(site).toHaveURL(`${SITE}/guides/guide-3.html`);

  // Search, from a page in a subfolder.
  await site.locator("#lumen-site-q").fill("apples");
  await expect(site.locator("#lumen-site-results li")).toHaveCount(15);
  await site.locator("#lumen-site-q").fill("תפוחים");
  await expect(site.locator("#lumen-site-results li")).toHaveCount(9);
  await site.locator("#lumen-site-results a").first().click();
  await expect(site.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await site.locator("main").evaluate((m) => getComputedStyle(m).direction)).toBe("rtl");

  // Every page of the site loads with its stylesheet and no console errors.
  const errors: string[] = [];
  site.on("pageerror", (e) => errors.push(e.message));
  for (const path of [...files.keys()].filter((f) => f.endsWith(".html"))) {
    const res = await site.goto(`${SITE}/${path.split("/").map(encodeURIComponent).join("/")}`);
    expect(res?.status(), path).toBe(200);
    await expect(site.locator(".lumen-site-bar")).toBeVisible();
  }
  expect(errors).toEqual([]);
});
