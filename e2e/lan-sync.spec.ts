import { test, expect, type BrowserContext, type Page, type Request } from "@playwright/test";

/**
 * Plan W2.19: two devices on one local network, no cloud. Two browser
 * contexts stand in for two devices: A keeps the vault, B pairs with it by
 * exchanging the two codes, unlocks with the passphrase, and from then on an
 * edit on either side arrives on the other on its own. No provider, no
 * signaling server, no STUN: the only requests either page makes are to the
 * app's own dev server, and the privacy ledger shows the link with a
 * local-network address only.
 *
 * Chromium hides local addresses behind mDNS names by default; a container
 * may not resolve those, so this spec turns that off to see real LAN
 * addresses (which the link checks against the local-network ranges).
 */
test.use({ launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] } });

const PASS = "a long passphrase for the lan vault";
const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

function vault(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const out: Record<string, string> = {};
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      for await (const [n, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const p = prefix ? `${prefix}/${n}` : n;
        if (h.kind === "directory") {
          if (!prefix && n.startsWith(".")) continue;
          await walk(h as FileSystemDirectoryHandle, p);
        } else if (p.endsWith(".md")) out[p] = await (await (h as FileSystemFileHandle).getFile()).text();
      }
    }
    await walk(await navigator.storage.getDirectory(), "");
    return out;
  });
}

function writeNote(page: Page, name: string, text: string) {
  return page.evaluate(
    async ([n, t]) => {
      const w = await (await (await navigator.storage.getDirectory()).getFileHandle(n, { create: true })).createWritable();
      await w.write(t);
      await w.close();
    },
    [name, text] as const,
  );
}

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  return page;
}

async function lanPanel(page: Page, role: "host" | "peer") {
  await page.bringToFront();
  await run(page, "sync.open");
  const panel = page.getByRole("dialog", { name: "Sync" });
  await expect(panel.getByText("Where to keep the encrypted vault")).toBeVisible({ timeout: 15_000 });
  await panel.getByLabel("Local network: another device here, no cloud").check();
  await panel.getByLabel(role === "host" ? "Keeps the vault: other devices pair with it" : "Joins a device that keeps the vault").check();
  return panel;
}

const result = (page: Page) => page.getByTestId("sync-result");

test("two devices on the local network pair, sync both ways on their own, and reach nothing else", async ({ browser, browserName, baseURL }) => {
  // skip-reason: the spec turns off Chromium's mDNS host-candidate hiding with a Chromium flag (above) to see LAN addresses; Firefox needs its own pref, not wired yet | task: W2.19 | until: 2027-05-12
  test.skip(browserName !== "chromium", "real LAN addresses need the Chromium flag above");
  test.setTimeout(120_000);
  const appHost = new URL(baseURL ?? "http://localhost:5173").host;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const elsewhere: string[] = [];
  const watch = (r: Request) => {
    const u = new URL(r.url());
    if ((u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:") && u.host !== appHost) elsewhere.push(r.url());
  };
  const a = await open(ctxA);
  const b = await open(ctxB);
  ctxA.on("request", watch);
  ctxB.on("request", watch);

  // A keeps the vault.
  await writeNote(a, "from-a.md", "# from A\n\nשלום");
  const pa = await lanPanel(a, "host");
  await pa.getByRole("button", { name: "Connect" }).click();
  await expect(pa.getByText("There is no vault there yet. Choose a passphrase to create it.")).toBeVisible({ timeout: 15_000 });
  await pa.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await pa.getByLabel("Repeat the passphrase").fill(PASS);
  await pa.getByRole("button", { name: "Encrypt and sync" }).click();
  await expect(result(a)).toContainText(/1 up, 0 down/, { timeout: 30_000 });

  // Pairing: A's code to B, B's answer back to A.
  await pa.getByRole("button", { name: "Pair a device", exact: true }).click();
  const offer = await pa.getByTestId("lan-offer-code").inputValue({ timeout: 15_000 });
  expect(offer).toMatch(/^lumen-lan:1:/);
  await expect(pa.getByRole("img", { name: "QR code of the pairing code" })).toBeVisible();

  await writeNote(b, "from-b.md", "# from B");
  const pb = await lanPanel(b, "peer");
  await pb.getByTestId("lan-offer-input").fill(offer);
  await pb.getByRole("button", { name: "Answer" }).click();
  const answer = await pb.getByTestId("lan-answer-code").inputValue({ timeout: 15_000 });

  await a.bringToFront();
  await pa.getByTestId("lan-answer-input").fill(answer);
  await pa.getByRole("button", { name: "Connect" }).click();
  await expect(pa.getByTestId("lan-peers")).toHaveAttribute("data-count", "1", { timeout: 30_000 });

  // B unlocks the vault it found on A and receives A's note.
  await b.bringToFront();
  await expect(pb.getByText("A vault is already there. Enter its passphrase.")).toBeVisible({ timeout: 30_000 });
  await pb.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await pb.getByRole("button", { name: "Unlock" }).click();
  await expect(result(b)).toContainText(/1 up, 1 down/, { timeout: 30_000 });
  await expect(pa.getByTestId("lan-peers")).toContainText(/· verified/, { timeout: 10_000 });

  // Live: A syncs a new note, and it reaches B in under 2 s with nobody touching B.
  await writeNote(a, "a-2.md", "second from A");
  await a.bringToFront();
  await pa.getByRole("button", { name: "Sync now" }).click();
  await expect(result(a)).toContainText(/1 up/, { timeout: 15_000 });
  const t0 = Date.now();
  await expect.poll(() => vault(b), { timeout: 2_000, intervals: [50] }).toMatchObject({ "a-2.md": "second from A" });
  expect(Date.now() - t0).toBeLessThan(2_000);
  // …and the other way: B's note reaches A, which syncs on its own when B writes.
  await writeNote(b, "b-2.md", "second from B");
  await b.bringToFront();
  await pb.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => vault(a), { timeout: 5_000, intervals: [50] }).toMatchObject({ "b-2.md": "second from B" });

  const want = { "from-a.md": "# from A\n\nשלום", "from-b.md": "# from B", "a-2.md": "second from A", "b-2.md": "second from B" };
  await expect.poll(() => vault(a), { timeout: 10_000 }).toMatchObject(want);
  await expect.poll(() => vault(b), { timeout: 10_000 }).toMatchObject(want);

  // Nothing but the app's own server, on either device…
  expect(elsewhere).toEqual([]);
  // …and the privacy ledger shows the link with a local-network address (or one the browser hid).
  for (const page of [a, b]) {
    const lan = await page.evaluate(() => (JSON.parse(localStorage.getItem("lumen.privacy.ledger") ?? "[]") as Array<{ method: string; host: string; category: string }>).filter((e) => e.method === "LAN"));
    expect(lan.length).toBeGreaterThan(0);
    for (const e of lan) {
      expect(e.category).toBe("local-ai");
      expect(e.host).toMatch(/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:|\[?::1\]?$|.*\.local$|address hidden)/i);
    }
  }
  await ctxA.close();
  await ctxB.close();
});
