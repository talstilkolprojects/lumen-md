import { request, type FullConfig } from "@playwright/test";

/**
 * Global setup: compile the app on the dev server before any test runs.
 *
 * Vite transforms a module the first time a browser asks for it. On a cold
 * CI runner the first page load of each Playwright worker therefore spent
 * most of its 30 s budget on Vite compiling hundreds of modules, and
 * whichever test happened to run first timed out in its beforeEach (the
 * first tests of ai-cancel, data-safety and dynamic-blocks-hardening were
 * "flaky" for exactly that reason; plan 0.5). This walks the module graph
 * from index.html over plain HTTP — no browser, so it works for every
 * project — and requests each module once, static and dynamic imports alike,
 * so the lazily-loaded blocks (graphviz, CSV, live-*) are compiled too.
 *
 * Against a production build (PLAYWRIGHT_BASE_URL → `dist/`) the same walk
 * just reads a few hashed files and is harmless.
 */

/** Absolute-path specifiers Vite writes into served modules. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)["'](\/[^"'\s]+)["']/g;
const SCRIPT_RE = /<script[^>]+src=["'](\/[^"']+)["']/g;
const MAX_MODULES = 5000;
const CONCURRENCY = 8;
const BUDGET_MS = 240_000;

export default async function warmup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL || process.env.PW_SKIP_WARMUP) return;
  const ctx = await request.newContext({ baseURL });
  const started = Date.now();
  const seen = new Set<string>();
  const queue: string[] = [];
  const add = (path: string) => {
    // Vite's HMR client and virtual modules need a page to mean anything.
    if (path.startsWith("/@vite/") || path.startsWith("/@react-refresh")) return;
    if (seen.has(path) || seen.size >= MAX_MODULES) return;
    seen.add(path);
    queue.push(path);
  };
  const failed: string[] = [];
  try {
    const html = await (await ctx.get("/", { timeout: 60_000 })).text();
    for (const m of html.matchAll(SCRIPT_RE)) add(m[1]);
    let inFlight = 0;
    const worker = async () => {
      while (Date.now() - started < BUDGET_MS) {
        const path = queue.shift();
        if (path === undefined) {
          // Empty for now: another crawler may still be adding to it.
          if (inFlight === 0) return;
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        inFlight++;
        try {
          const res = await ctx.get(path, { timeout: 120_000 });
          const type = res.headers()["content-type"] ?? "";
          if (!res.ok()) failed.push(`${path} → ${res.status()}`);
          else if (/javascript|typescript/.test(type)) {
            for (const m of (await res.text()).matchAll(IMPORT_RE)) add(m[1]);
          }
        } catch (e) {
          failed.push(`${path} → ${(e as Error).message.split("\n")[0]}`);
        } finally {
          inFlight--;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (e) {
    // A warm-up that cannot reach the server must not hide the real error:
    // the tests themselves will report it.
    console.warn(`[warmup] skipped: ${(e as Error).message}`);
  } finally {
    await ctx.dispose();
  }
  console.log(`[warmup] ${seen.size} modules in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  // Informational: a module the app never loads may well 404 here.
  if (failed.length) console.log(`[warmup] ${failed.length} not loaded:\n  ${failed.slice(0, 10).join("\n  ")}`);
}
