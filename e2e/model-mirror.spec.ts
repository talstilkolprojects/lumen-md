import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HF_HOSTS, MIRROR_PATH, mirrorScenario, syntheticMirror } from "./fixtures/modelMirror";
import { isDefaultCandidate, silentHfOnly, type HostedModel } from "../src/ai/modelHosting";

/**
 * Plan W6.33: models without Hugging Face. huggingface.co is blocked for the
 * whole test; every model that may be a default loads from the mirror, its
 * bytes checked against the registry, into the cache its library reads.
 *
 *  - Default (no network): a synthetic mirror on the page's own origin with
 *    made-up files whose sha256 is in a synthetic copy of the registry
 *    (e2e/fixtures/modelMirror.ts). It checks the chain, not the files.
 *  - MODEL_MIRROR_URL=https://<mirror>/ (the owner or the second host, after
 *    `npm run owner:models`; the dev server started with the same
 *    VITE_MODEL_MIRROR_URL so the CSP allows it): the real registry and the
 *    deployed mirror. MODEL_MIRROR_REQUIRE_ALL=1 also requires 24/24 pinned.
 *
 * And the check that needs no browser: no model is only on Hugging Face
 * without a message, in English and in Hebrew.
 */
const ROOT = join(__dirname, "..");
const registry = JSON.parse(readFileSync(join(ROOT, "models", "registry.json"), "utf8")) as { models: HostedModel[] };
const REAL = process.env.MODEL_MIRROR_URL?.replace(/\/+$/, "") ?? "";

test("0 models only on Hugging Face without a message (en, he)", () => {
  const en = JSON.parse(readFileSync(join(ROOT, "src", "i18n", "lazy", "modelSources.json"), "utf8")) as Record<string, string>;
  const he = JSON.parse(readFileSync(join(ROOT, "src", "i18n", "locales", "he", "common.json"), "utf8")) as Record<string, string>;
  expect(registry.models.filter(isDefaultCandidate).length).toBe(24);
  expect(silentHfOnly(registry.models, en)).toEqual([]);
  expect(silentHfOnly(registry.models, he)).toEqual([]);
});

test("with huggingface.co blocked, every default model loads from the mirror", async ({ page, baseURL }) => {
  test.setTimeout(REAL ? 3_600_000 : 120_000);
  const hfRequests: string[] = [];
  await page.route((url) => HF_HOSTS.some((re) => re.test(url.href)), (route) => {
    hfRequests.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const synthetic = syntheticMirror(registry.models);
  const origin = new URL(baseURL ?? "http://localhost:5173").origin;
  const mirror = REAL || `${origin}${MIRROR_PATH}`;
  if (!REAL) {
    await page.route(`${origin}${MIRROR_PATH}/**`, (route) => {
      const rest = decodeURIComponent(new URL(route.request().url()).pathname.slice(MIRROR_PATH.length + 1));
      const data = synthetic.files.get(rest);
      return data ? route.fulfill({ status: 200, body: data, contentType: "application/octet-stream" }) : route.fulfill({ status: 404, body: "" });
    });
  }
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  const dev = await page.evaluate(() => !!document.querySelector('script[src*="/@vite/client"]'));
  test.skip(!dev, "imports src/ai/modelHosting.ts from the dev server");

  const models = REAL ? registry.models.filter((m) => isDefaultCandidate(m) && m.files?.length && m.hosting?.via !== "converted") : synthetic.models;
  if (REAL && process.env.MODEL_MIRROR_REQUIRE_ALL === "1") expect(registry.models.filter((m) => isDefaultCandidate(m) && m.files?.length).length).toBe(24);
  const results = await page.evaluate(mirrorScenario, { modulePath: "/src/ai/modelHosting.ts", mirror, models });
  expect(results.filter((r) => r.error)).toEqual([]);
  for (const r of results) {
    expect(r.kinds?.every((k) => k === "mirror"), r.id).toBe(true);
    expect(r.inCache, r.id).toBe(r.files);
  }
  if (!REAL) {
    // 24 defaults: the synthetic ones plus the converted ones, which never ask Hugging Face (modelCache.ts).
    expect(results.length + synthetic.converted.length).toBe(24);
    // Hugging Face was asked first and blocked; nothing came from it.
    expect(hfRequests.length).toBeGreaterThan(0);
  }
});

test("a mirror that serves other bytes is refused with a clear error", async ({ page, baseURL }) => {
  await page.route((url) => HF_HOSTS.some((re) => re.test(url.href)), (route) => route.abort("blockedbyclient"));
  const origin = new URL(baseURL ?? "http://localhost:5173").origin;
  const { models } = syntheticMirror(registry.models);
  const one = models[0];
  await page.route(`${origin}${MIRROR_PATH}/**`, (route) => route.fulfill({ status: 200, body: Buffer.alloc(one.files![0].bytes, 1) }));
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  const dev = await page.evaluate(() => !!document.querySelector('script[src*="/@vite/client"]'));
  test.skip(!dev, "imports src/ai/modelHosting.ts from the dev server");
  const [r] = await page.evaluate(mirrorScenario, { modulePath: "/src/ai/modelHosting.ts", mirror: `${origin}${MIRROR_PATH}`, models: [one] });
  expect(r.error).toMatch(/no source gave the expected file .*mirror: sha256/);
});
