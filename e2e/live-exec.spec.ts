import { test, expect } from "@playwright/test";
import { productionWorkerOrSkip } from "./_serviceWorker";

/**
 * REAL execution proof for the live code blocks (master-plan §3). Until now
 * these had smoke-only unit tests ("renders chrome, never loads the
 * runtime") — AND, as this spec uncovered, both runtimes were loaded from a
 * CDN that the app's `script-src 'self'` CSP silently blocked, so the blocks
 * never ran in production. Both runtimes are now self-hosted same-origin
 * (sql.js bundled from npm; Pyodide staged into public/pyodide/ by
 * scripts/copy-pyodide.mjs). This spec boots each real WASM runtime in a
 * browser, runs code, and asserts the COMPUTED output — values that never
 * appear in the source.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
  // The welcome doc is seeded after mount. Wait for it, so the tests'
  // select-all + type replaces it instead of racing it (WebKit typed into a
  // half-seeded doc and the block swallowed welcome text).
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("live-sql executes a real query via sql.js WASM", async ({ page }) => {
  test.setTimeout(120_000);
  await page.keyboard.press("Meta+2"); // split: source + preview
  const editor = page.locator(".cm-content").first();
  await editor.click();
  // Use a SELECT-all + type so the async-seeded welcome doc can't survive
  // alongside our block, and a value (1763) that appears nowhere else.
  await editor.press("ControlOrMeta+a");
  await editor.fill("```live-sql\nSELECT 1000 + 763 AS answer;\n```\n");

  // Scope to the live-sql block itself (the welcome doc renders its OWN
  // chart-blocks, so `.first()` would grab the wrong one).
  const block = page.locator(".chart-block", {
    has: page.getByRole("button", { name: "Run SQL" }),
  });
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Run SQL" }).click();

  // WASM init + query — 1763 is computed by SQLite, never present in source.
  await expect(block).toContainText("1763", { timeout: 90_000 });
});

test("live-python executes real Python via Pyodide WASM", async ({ page }) => {
  test.setTimeout(300_000);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("```live-python\nprint(sum(range(100)) + 7)\n```\n");

  // Scope to the live-python block (the welcome doc renders other blocks).
  const block = page.locator(".chart-block", {
    has: page.getByRole("button", { name: "Run Python" }),
  });
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Run Python" }).click();

  // sum(range(100)) + 7 = 4957 — computed by the interpreter; the literal
  // never appears in the source.
  await expect(block).toContainText("4957", { timeout: 240_000 });
});

test("live-glsl compiles and renders a shader on a WebGL canvas", async ({ page }) => {
  test.setTimeout(60_000);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  // fill() sets the value atomically — pressSequentially would trigger
  // CodeMirror's auto-close-brackets and double the shader's braces.
  await editor.fill("```live-glsl\nvoid main(){ gl_FragColor = vec4(0.9, 0.2, 0.1, 1.0); }\n```\n");

  // The block renders an error view WITHOUT a canvas when WebGL is missing
  // or the shader fails; assert on the error text first so a failure says
  // which one it was instead of just "no canvas".
  const anyGlsl = page.locator(".chart-block", { hasText: /GLSL/ }).first();
  await expect(anyGlsl).toBeVisible({ timeout: 15_000 });
  await expect(anyGlsl).not.toContainText("GLSL error", { timeout: 5_000 }).catch(async (err: Error) => {
    // Say what the browser offers, so "no WebGL" is distinguishable from a bug.
    const env = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const msgs: string[] = [];
      c.addEventListener("webglcontextcreationerror", (e) => msgs.push((e as WebGLContextEvent).statusMessage));
      const gl1 = !!c.getContext("webgl");
      const gl2 = !!document.createElement("canvas").getContext("webgl2");
      return `webgl=${gl1} webgl2=${gl2} reasons=[${msgs.join(" | ")}] ua=${navigator.userAgent}`;
    });
    throw new Error(`${err.message.split("\n")[0]}\nblock: ${await anyGlsl.innerText()}\nenv: ${env}`);
  });
  const block = page.locator(".chart-block", { has: page.locator("canvas") });
  await expect(block).toBeVisible({ timeout: 15_000 });
  const canvas = block.locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  // The block calls setError on any compile/link failure (or missing WebGL).
  // A clean render with a sized canvas proves the GLSL pipeline executed.
  await expect(block).not.toContainText(/compile failed|link failed|not available/i, {
    timeout: 10_000,
  });
  const box = await canvas.boundingBox();
  expect(box, "GLSL canvas must have a bounding box").not.toBeNull();
  expect(box!.width).toBeGreaterThan(50);
});

test("live-lua executes real Lua via wasmoon WASM in a worker", async ({ page }) => {
  test.setTimeout(120_000);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("```live-lua\nlocal s = 0\nfor i = 1, 100 do s = s + i end\nprint(s + 13)\n```\n");

  // Diagnostics: Firefox/WebKit CI runs stalled at "Running…" without the
  // hard-kill timer ever firing, and job logs aren't reachable — so a failure
  // must carry what the page saw (console, page errors, worker lifecycle,
  // whether the main thread still answers) in its own message.
  const diag: string[] = [];
  page.on("console", (m) => diag.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => diag.push(`pageerror: ${e.message}`));
  page.on("worker", (w) => {
    diag.push(`worker started: ${w.url()}`);
    w.on("close", () => diag.push(`worker closed: ${w.url()}`));
  });
  page.on("requestfailed", (r) => diag.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));

  const block = page.locator('[data-testid="live-lua"]');
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Run" }).click();

  // 5050 + 13 = 5063 — computed by the Lua VM, never present in the source.
  try {
    await expect(block).toContainText("5063", { timeout: 60_000 });
  } catch (err) {
    const alive = await Promise.race([
      page.evaluate(() => "main thread responsive").catch((e: Error) => `evaluate failed: ${e.message}`),
      new Promise<string>((r) => setTimeout(() => r("main thread BLOCKED (evaluate timed out)"), 5_000)),
    ]);
    const state = await block.getAttribute("data-state", { timeout: 2_000 }).catch(() => "?");
    const text = await block.innerText({ timeout: 2_000 }).catch(() => "?");
    const blocks = await block.count();
    const doc = await editor.innerText({ timeout: 2_000 }).catch(() => "?");
    throw new Error(
      `live-lua never printed 5063. blocks=${blocks} data-state=${state}; ${alive}\nblock: ${text.slice(0, 400)}\n` +
        `editor: ${doc.slice(0, 300)}\n` +
        diag.slice(-40).join("\n") +
        `\n--- ${(err as Error).message.split("\n")[0]}`,
    );
  }
});

test("live-r executes real R via webR and draws a plot", async ({ page }) => {
  test.setTimeout(240_000);
  // webR is GPL-3.0 and never part of the build (W1.34): this test needs a
  // deployment's own copy under /webr/ (`npm run webr:local`, as the dev
  // server in playwright.config.ts makes). The e2e gate's dist/ has none.
  const served = await page.evaluate(async () => {
    try {
      const r = await fetch("/webr/webr.js", { cache: "no-store" });
      return r.ok && /javascript/.test(r.headers.get("content-type") ?? "");
    } catch {
      return false;
    }
  });
  // skip-reason: no webR under /webr/ here (the production build ships none; run with npm run webr:local) | task: W4.2 | until: 2027-05-12
  test.skip(!served, "webR is not served under /webr/ (run `npm run webr:local` first)");
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  // R can evaluate JavaScript in its worker (webr::eval_js): the worker is
  // isolated, so storage APIs are gone there.
  await editor.fill(
    "```live-r\nx <- 1:100\ncat(sum(x) + 37, \"\\n\")\ncat(webr::eval_js(\"[typeof indexedDB, typeof caches, String(navigator.storage), typeof WebSocketStream].join('/')\"), \"\\n\")\ncat(webr::eval_js(\"try { importScripts('https://example.com/x.js'); 'loaded' } catch (e) { 'blocked' }\"), \"\\n\")\nplot(x, x^2)\n```\n",
  );

  const diag: string[] = [];
  page.on("console", (m) => diag.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => diag.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => diag.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));

  const block = page.locator('[data-testid="live-r"]');
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Run" }).click();

  // 5050 + 37 = 5087 — computed by R, never present in the source.
  try {
    await expect(block).toContainText("5087", { timeout: 200_000 });
  } catch (err) {
    const state = await block.getAttribute("data-state").catch(() => "?");
    const text = await block.innerText().catch(() => "?");
    throw new Error(`live-r never printed 5087. data-state=${state}\nblock: ${text.slice(0, 400)}\n${diag.slice(-25).join("\n")}\n${String(err)}`);
  }
  await expect(block).toContainText("undefined/undefined/undefined/undefined");
  await expect(block).toContainText("blocked");
  await expect(block.locator("canvas")).toHaveCount(1);
  await expect(block).toHaveAttribute("data-state", "success");
});

test("live-r without webR offers the download with its licence, and fetches nothing until asked", async ({ page }) => {
  // No webR on this device or this server (plan W1.34).
  await page.route("**/webr/**", (r) => r.fulfill({ status: 404, body: "" }));
  const cdn: string[] = [];
  page.on("request", (r) => {
    if (/webr\.r-wasm\.org|cdn\.jsdelivr\.net/.test(r.url())) cdn.push(r.url());
  });
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("```live-r\ncat(1 + 1)\n```\n");
  const block = page.locator('[data-testid="live-r"]');
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Run" }).click();
  const offer = block.getByTestId("live-r-install");
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await expect(offer).toContainText("GNU GPL version 3");
  await expect(offer.getByRole("link", { name: /GPL-3\.0/ })).toHaveAttribute("href", /github\.com\/r-wasm\/webr\/blob\/v[\d.]+\/LICENSE\.md/);
  await expect(offer.getByRole("button", { name: /Download R/ })).toBeEnabled();
  await expect(block).toHaveAttribute("data-state", "install");
  expect(cdn).toEqual([]);
});

test("live-ruby executes real Ruby via ruby.wasm in a sandboxed worker", async ({ page }) => {
  test.setTimeout(240_000);
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  // The JS bridge is refused (the worker is sandboxed); the rest runs.
  await editor.fill(
    '```live-ruby\nputs (1..100).sum + 41\nbegin\n  require "js"\nrescue LoadError => e\n  puts "blocked: #{e.message[0, 13]}"\nend\n[1, 2].map { _1 * 3 }\n```\n',
  );

  const diag: string[] = [];
  page.on("console", (m) => diag.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => diag.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => diag.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));

  const block = page.locator('[data-testid="live-ruby"]');
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Run" }).click();

  // 5050 + 41 = 5091 — computed by Ruby, never present in the source.
  try {
    await expect(block).toContainText("5091", { timeout: 200_000 });
  } catch (err) {
    const state = await block.getAttribute("data-state").catch(() => "?");
    const text = await block.innerText().catch(() => "?");
    throw new Error(`live-ruby never printed 5091. data-state=${state}\nblock: ${text.slice(0, 400)}\n${diag.slice(-25).join("\n")}\n${String(err)}`);
  }
  await expect(block).toContainText("blocked: The JS bridge");
  await expect(block).toContainText("=> [3, 6]");
  await expect(block).toHaveAttribute("data-state", "success");

  // A runaway loop is killed by the page and the next Run works again.
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("```live-ruby timeout=1500\nloop {}\n```\n\n```live-ruby\nputs 6 * 7\n```\n");
  const [looping, after] = [block.nth(0), block.nth(1)];
  await looping.getByRole("button", { name: "Run" }).click();
  await expect(looping).toHaveAttribute("data-state", "timeout", { timeout: 60_000 });
  await after.getByRole("button", { name: "Run" }).click();
  await expect(after).toContainText("42", { timeout: 120_000 });
});

test("live-ruby runs offline once the runtime was loaded (service-worker runtime cache)", async ({ page, context, browserName }) => {
  test.setTimeout(240_000);
  // Production builds only: the dev server registers no service worker.
  const dev = await page.evaluate(() => !!document.querySelector('script[src*="/@vite/client"]'));
  productionWorkerOrSkip(dev, browserName, { chromiumOnly: false });
  const hasSw = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    return reg;
  });
  // On a production build a missing worker is a regression, not a reason to skip.
  expect(hasSw).toBe(true);
  // The worker's fetch goes through the SW only once the page is controlled.
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  }
  const runOnce = async (expected: string) => {
    await page.keyboard.press("Meta+2");
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await editor.press("ControlOrMeta+a");
    await editor.fill("```live-ruby\nputs [3, 4].sum * 1000 + 7\n```\n");
    const block = page.locator('[data-testid="live-ruby"]');
    await block.getByRole("button", { name: "Run" }).click();
    await expect(block).toContainText(expected, { timeout: 200_000 });
  };
  await runOnce("7007");
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
    await runOnce("7007");
  } finally {
    await context.setOffline(false);
  }
});

/**
 * Plan 6.14: the `run_python` agent tool on the same self-hosted Pyodide,
 * called the way the agent runtime calls it (window.__lumen.runPython, the
 * read scope only). It computes from `inputs`; every way to the network
 * from Python fails inside the worker, nothing reaches the probe host, and
 * each attempt is in the privacy ledger. A second call is stopped by its
 * time limit.
 */
test("run_python agent tool computes offline and every network path fails", async ({ page, context }) => {
  test.setTimeout(480_000);
  const probeHits: string[] = [];
  // Nothing may reach the probe host; if a request did leave, it is counted and dropped here.
  await context.route(/^https?:\/\/example\.com\//, (route) => {
    probeHits.push(route.request().url());
    return route.abort();
  });
  context.on("request", (req) => {
    if (/^(https?|wss?):\/\/example\.com\//.test(req.url())) probeHits.push(req.url());
  });
  await page.waitForFunction(() => typeof (window as unknown as { __lumen?: { runPython?: unknown } }).__lumen?.runPython === "function", null, { timeout: 15_000 });

  const P = "https://example.com/lumen-sandbox-probe/";
  const code = [
    "print(sorted(inputs['xs'])[-1] * 100 + sum(range(100)) - 4950 + 7)",
    "import js, sys, urllib.request",
    "out = []",
    "async def attempt(name, f):",
    "    try:",
    "        r = f()",
    "        if hasattr(r, '__await__'):",
    "            await r",
    "        out.append(name + ':LEAKED')",
    "    except BaseException:",
    "        out.append(name + ':blocked')",
    "from pyodide.http import pyfetch, open_url",
    `await attempt('pyfetch', lambda: pyfetch('${P}pyfetch'))`,
    `await attempt('js.fetch', lambda: js.fetch('${P}js-fetch'))`,
    `await attempt('micropip', lambda: __import__('micropip').install('${P}pkg.whl'))`,
    `await attempt('urllib', lambda: urllib.request.urlopen('${P}urllib', timeout=5))`,
    `await attempt('open_url', lambda: open_url('${P}open-url'))`,
    "await attempt('xhr', lambda: js.XMLHttpRequest.new())",
    "await attempt('loadPackage', lambda: __import__('pyodide_js').loadPackage('numpy'))",
    "await attempt('run_js', lambda: __import__('pyodide.code', fromlist=['run_js']).run_js('1'))",
    "await attempt('vault', lambda: js.indexedDB.open('lumen'))",
    "','.join(out)",
  ].join("\n");

  type Result = { ok: boolean; stdout: string; result: unknown; error: string | null; timedOut: boolean; blocked: Array<{ api: string }> };
  const callTool = (args: Record<string, unknown>) =>
    page.evaluate(
      (a) => (window as unknown as { __lumen: { runPython: (x: Record<string, unknown>) => Promise<unknown> } }).__lumen.runPython(a),
      args,
    ) as Promise<Result>;

  const res = await callTool({ code, inputs: { xs: [3, 41, 9] } });
  expect(res.error).toBeNull();
  expect(res.ok).toBe(true);
  // 41 * 100 + 4950 - 4950 + 7 = 4107 — computed by CPython, not in the source.
  expect(res.stdout).toContain("4107");
  expect(String(res.result).split(",")).toEqual([
    "pyfetch:blocked",
    "js.fetch:blocked",
    "micropip:blocked",
    "urllib:blocked",
    "open_url:blocked",
    "xhr:blocked",
    "loadPackage:blocked",
    "run_js:blocked",
    "vault:blocked",
  ]);
  const apis = res.blocked.map((b) => b.api);
  for (const api of ["pyodide.http.pyfetch", "fetch", "micropip.install", "python:urllib.Request", "pyodide.http.open_url", "XMLHttpRequest", "pyodide.loadPackage", "pyodide.code.run_js"]) {
    expect(apis, api).toContain(api);
  }
  const ledger = (await page.evaluate(() => (window as unknown as { __lumen: { ledger: () => unknown } }).__lumen.ledger())) as Array<{ reason: string; decision: string; host: string }>;
  const blocked = ledger.filter((e) => e.reason.includes("run_python"));
  expect(blocked.length).toBe(res.blocked.length);
  expect(blocked.every((e) => e.decision === "blocked")).toBe(true);
  expect(probeHits).toEqual([]);

  const stuck = await callTool({ code: "while True:\n    pass", timeoutMs: 1500 });
  expect(stuck).toMatchObject({ ok: false, timedOut: true });
  expect(probeHits).toEqual([]);
});
