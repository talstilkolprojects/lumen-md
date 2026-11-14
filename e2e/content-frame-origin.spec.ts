/**
 * Plan W6.40 (review E52): the content frame runs on its own origin, never
 * the app's. In e2e the frame site is the dev server by its other loopback
 * name (playwright.config.ts: VITE_CONTENT_FRAME_URL). Code evaluated inside
 * each frame stands in for a future XSS there: it must not reach the app's
 * localStorage, IndexedDB or document.
 */
import { expect, test, type Frame, type Page } from "@playwright/test";

const SECRET = "lumen-e2e-vault-secret";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A content frame made by the app's own module, as the preview makes it. */
async function contentFrame(page: Page, request: object): Promise<{ tag: string; src: string; frame: Frame | null }> {
  const made = await page.evaluate(async (r) => {
    const m = await import(/* @vite-ignore */ "/src/lib/contentFrame.ts");
    const el = m.createContentFrame(r as Parameters<typeof m.createContentFrame>[0]);
    document.body.append(el);
    return { tag: el.tagName, src: el.getAttribute("src") ?? el.getAttribute("href") ?? "" };
  }, request);
  if (made.tag !== "IFRAME") return { ...made, frame: null };
  await expect.poll(() => page.frames().some((f) => f.url() === made.src)).toBe(true);
  const frame = page.frames().find((f) => f.url() === made.src)!;
  await frame.waitForLoadState();
  return { ...made, frame };
}

/** What code running in `frame` can reach. */
const reach = (frame: Frame) =>
  frame.evaluate(async (secret) => {
    const t = (f: () => unknown) => {
      try {
        return String(f());
      } catch (e) {
        return (e as Error).name;
      }
    };
    const dbs = await indexedDB.databases().then((l) => l.map((d) => d.name).join(","), (e: Error) => e.name);
    return { origin: self.origin, storage: t(() => localStorage.getItem(secret)), parent: t(() => parent.document.title), dbs };
  }, SECRET);

test.beforeEach(async ({ page }) => {
  await page.context().route(/^https:\/\/(img\.lumen-e2e\.test|www\.youtube-nocookie\.com)\//, (route) =>
    route.request().url().includes("img.")
      ? route.fulfill({ contentType: "image/png", body: PNG })
      : route.fulfill({ contentType: "text/html", body: "<!doctype html><title>player</title>" }),
  );
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.setItem(s, "SECRET");
    indexedDB.open("lumen-e2e-app-db");
  }, SECRET);
});

for (const [kind, request] of [
  ["img", { kind: "img", src: "https://img.lumen-e2e.test/a.png", alt: "a" }],
  ["video", { kind: "video", src: "https://img.lumen-e2e.test/v.mp4" }],
  ["embed", { kind: "embed", src: "https://www.youtube-nocookie.com/embed/e2e", title: "Player" }],
  ["gist", { kind: "gist", user: "someone", id: "abc123" }],
] as const) {
  test(`${kind}: a script in the content frame can't reach the app's storage or document`, async ({ page }) => {
    const app = new URL(page.url()).origin;
    const { tag, src, frame } = await contentFrame(page, request);
    expect(tag).toBe("IFRAME");
    expect(new URL(src).origin).not.toBe(app);
    const r = await reach(frame!);
    expect(r.origin).not.toBe(app);
    expect(r.storage).not.toBe("SECRET");
    expect(r.parent).toBe("SecurityError");
    expect(r.dbs).not.toContain("lumen-e2e-app-db");
    // Only an embed keeps an origin of its own, and it is the frame site's.
    expect(r.origin).toBe(kind === "embed" ? new URL(src).origin : "null");
  });
}
