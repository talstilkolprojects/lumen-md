/**
 * Real services (plan 7.2.4, T15): LanguageTool and SearXNG as the nightly
 * job runs them (service containers). Skipped unless their URLs are set:
 *
 *   LUMEN_REAL_LANGUAGETOOL_URL  e.g. http://127.0.0.1:8010/v2/check
 *   LUMEN_REAL_SEARXNG_URL       e.g. http://127.0.0.1:8888
 *
 * LanguageTool has no Hebrew, so it is checked in English only. SearXNG is
 * AGPL: an outside test service, never shipped.
 */
import { describe, it, expect } from "vitest";

const lt = process.env.LUMEN_REAL_LANGUAGETOOL_URL || "";
const sx = (process.env.LUMEN_REAL_SEARXNG_URL || "").replace(/\/+$/, "");

describe.skipIf(!lt)("LanguageTool (real)", () => {
  it("finds the error in an English sentence through Lumen's grammar client", async () => {
    const { checkGrammar, grammarEndpoint, GRAMMAR_ENDPOINT_KEY } = await import("../../ai/grammar");
    localStorage.setItem(GRAMMAR_ENDPOINT_KEY, lt);
    expect(grammarEndpoint()).toBe(lt);
    // At least 40 characters: shorter text is not sent.
    const matches = await checkGrammar("This are a test of the grammar checker that runs on this machine.", "en-US");
    expect(matches.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!sx)("SearXNG (real)", () => {
  it("answers a JSON search (search.formats: json, limiter: false)", async () => {
    const r = await fetch(`${sx}/search?q=lumen+markdown&format=json`, { signal: AbortSignal.timeout(30_000) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results?: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  }, 60_000);
});
