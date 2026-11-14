/** T37 — the privacy ledger records AI requests and enforces local-only. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetLedger, classify, installPrivacyLedger, ledgerFetch, leftDevice, ledgerEntries, ledgerSummary, PrivacyBlockedError, recordBlockedRequest, recordBrowserResource, subscribeLedger, withLedger } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

function fakeFetch() {
  return vi.fn(async () => new Response("ok", { status: 200, headers: { "content-length": "2" } }));
}

describe("privacy ledger", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLedger();
  });

  it("classifies AI destinations and ignores everything else", () => {
    expect(classify("https://api.openai.com/v1/chat/completions")?.category).toBe("cloud-ai");
    expect(classify("https://api.anthropic.com/v1/messages")?.category).toBe("cloud-ai");
    expect(classify("https://api.languagetool.org/v2/check")?.category).toBe("cloud-text");
    expect(classify("https://huggingface.co/x/resolve/main/model.onnx")?.category).toBe("model-download");
    expect(classify("http://localhost:11434/api/chat")?.category).toBe("local-ai");
    expect(classify("https://fonts.googleapis.com/css2")).toBeNull();
    expect(classify("/assets/app.js")).toBeNull();
  });

  it("records a cloud request with sizes, never its body", async () => {
    setAiPolicy("cloud");
    const inner = fakeFetch();
    const f = withLedger(inner as unknown as typeof fetch);
    await f("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ prompt: "secret plan שלום" }) });
    const [e] = ledgerEntries();
    expect(e).toMatchObject({ host: "api.anthropic.com", method: "POST", decision: "allowed", category: "cloud-ai", bytesIn: 2, status: 200 });
    expect(e.bytesOut).toBeGreaterThan(20);
    expect(JSON.stringify(e)).not.toContain("secret plan");
    expect(ledgerSummary().cloudRequests).toBe(1);
  });

  it("blocks cloud AI under local-only and never calls the network", async () => {
    setAiPolicy("local-only");
    const inner = fakeFetch();
    const f = withLedger(inner as unknown as typeof fetch);
    await expect(f("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(inner).not.toHaveBeenCalled();
    expect(ledgerEntries()[0]).toMatchObject({ decision: "blocked", policy: "local-only" });
  });

  it("local-only still allows local Ollama and model downloads", async () => {
    setAiPolicy("local-only");
    const inner = fakeFetch();
    const f = withLedger(inner as unknown as typeof fetch);
    await f("http://localhost:11434/api/tags");
    await f("https://huggingface.co/m/resolve/main/w.bin");
    expect(inner).toHaveBeenCalledTimes(2);
    expect(ledgerEntries().map((e) => e.decision)).toEqual(["allowed", "allowed"]);
  });

  it("passes other traffic through untouched and unrecorded", async () => {
    const inner = fakeFetch();
    const f = withLedger(inner as unknown as typeof fetch);
    await f("https://example.com/a");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(ledgerEntries()).toHaveLength(0);
  });

  it("classifies the configured research and grammar endpoints by origin", async () => {
    localStorage.setItem("lumen.research.endpoint", "https://worker.example.com");
    localStorage.setItem("lumen.grammar.endpoint", "https://lt.example.org/v2/check");
    expect(classify("https://worker.example.com/extract?url=https%3A%2F%2Fa.b")?.category).toBe("research");
    expect(classify("https://worker.example.com/search")?.category).toBe("research");
    expect(classify("https://worker.example.com/other")).toBeNull();
    expect(classify("https://lt.example.org/v2/check")?.category).toBe("cloud-text");
    localStorage.setItem("lumen.grammar.endpoint", "http://localhost:8010/v2/check");
    expect(classify("http://localhost:8010/v2/check")?.category).toBe("local-ai");
    // local-only stops cited URLs from leaving through the research worker.
    setAiPolicy("local-only");
    const inner = fakeFetch();
    const f = withLedger(inner as unknown as typeof fetch);
    await expect(f("https://worker.example.com/extract?url=x")).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(inner).not.toHaveBeenCalled();
  });

  it("emits a new snapshot for every change (useSyncExternalStore)", async () => {
    setAiPolicy("cloud");
    const snaps: unknown[] = [];
    subscribeLedger(() => snaps.push(ledgerEntries()));
    const f = withLedger(fakeFetch() as unknown as typeof fetch);
    const before = ledgerEntries();
    await f("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" });
    expect(snaps).toHaveLength(2); // recorded, then response sizes
    expect(snaps[0]).not.toBe(before);
    expect(snaps[1]).not.toBe(snaps[0]);
    expect(ledgerEntries()[0]).toMatchObject({ bytesIn: 2, status: 200 });
  });

  it("blocked attempts did not leave the device", async () => {
    setAiPolicy("local-only");
    const f = withLedger(fakeFetch() as unknown as typeof fetch);
    await f("https://api.openai.com/v1/x").catch(() => { /* why: local-only blocks this request on purpose; the test checks the ledger, not the rejection */ });
    await f("http://localhost:11434/api/tags");
    setAiPolicy("cloud");
    await f("https://api.openai.com/v1/x");
    expect(ledgerEntries().map(leftDevice)).toEqual([false, false, true]);
  });

  it("counts the query string of a GET as sent, on top of the body", async () => {
    setAiPolicy("cloud");
    const f = withLedger(fakeFetch() as unknown as typeof fetch);
    await f("https://huggingface.co/x/resolve/main/model.onnx?download=true");
    await f("https://api.openai.com/v1/chat/completions?x=1", { method: "POST", body: "{}" });
    await f("https://api.openai.com/v1/models"); // no query, no body
    const sent = ledgerEntries().map((e) => e.bytesOut);
    expect(sent).toEqual(["download=true".length, 2 + "x=1".length, 0]);
  });

  it("the webR download the user asks for is a model download (allowed under local-only); other jsDelivr traffic is third-party (plan W1.34)", async () => {
    expect(classify("https://webr.r-wasm.org/v0.6.0/R.wasm")).toMatchObject({ host: "webr.r-wasm.org", category: "model-download" });
    expect(classify("https://cdn.jsdelivr.net/npm/webr@0.6.0/dist/R.wasm")).toMatchObject({ category: "model-download" });
    expect(classify("https://cdn.jsdelivr.net/npm/other@1/x.js")).toMatchObject({ category: "third-party" });
    const inner = vi.fn(async () => new Response("x", { status: 200 }));
    const f = withLedger(inner as unknown as typeof fetch);
    setAiPolicy("local-only");
    await expect(f("https://webr.r-wasm.org/v0.6.0/R.wasm")).resolves.toBeInstanceOf(Response);
    await expect(f("https://cdn.jsdelivr.net/npm/other@1/x.js")).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(ledgerEntries().map((e) => [e.category, e.decision])).toEqual([
      ["model-download", "allowed"],
      ["third-party", "blocked"],
    ]);
    setAiPolicy("local-first");
  });

  it("Excalidraw's font fallback CDN is third-party traffic — blocked under local-only, never needed (fonts are served locally, plan 4.19)", async () => {
    const font = "https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2";
    expect(classify(font)).toMatchObject({ host: "esm.sh", category: "third-party" });
    const inner = vi.fn(async () => new Response("x", { status: 200 }));
    const f = withLedger(inner as unknown as typeof fetch);
    setAiPolicy("local-only");
    await expect(f(font)).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(inner).not.toHaveBeenCalled();
    expect(ledgerEntries().map((e) => [e.category, e.decision])).toEqual([["third-party", "blocked"]]);
    // nothing in the ledger mentions tldraw any more
    expect(classify("https://cdn.tldraw.com/4.5.10/fonts/IBMPlexSans-Medium.woff2")).toBeNull();
    setAiPolicy("local-first");
  });

  it("records consented and forced requests (agent network tools), and refusals made before a request", async () => {
    setAiPolicy("local-only");
    const inner = fakeFetch();
    const force = { category: "research" as const, reason: "Agent tool fetch_page" };
    // Forced: recorded even for a URL classify() does not track; still blocked without consent.
    await expect(withLedger(inner as unknown as typeof fetch, { force })("https://pages.example.net/x")).rejects.toBeInstanceOf(PrivacyBlockedError);
    await withLedger(inner as unknown as typeof fetch, { force, consent: true })("https://pages.example.net/x");
    expect(inner).toHaveBeenCalledTimes(1);
    const err = recordBlockedRequest("https://r.example.com/search", "research", "Agent tool search_web (local-only, no consent)");
    expect(err).toBeInstanceOf(PrivacyBlockedError);
    expect(ledgerEntries().map((e) => [e.host, e.decision, e.consent ?? false])).toEqual([
      ["pages.example.net", "blocked", false],
      ["pages.example.net", "allowed", true],
      ["r.example.com", "blocked", false],
    ]);
    // Consent only matters where the policy would block: outside local-only nothing is flagged.
    setAiPolicy("local-first");
    await withLedger(inner as unknown as typeof fetch, { force, consent: true })("https://pages.example.net/y");
    expect(ledgerEntries()[3].consent).toBeUndefined();
  });

  it("builds a consented fetch on the unwrapped fetch, so it is recorded once and not blocked by the global wrapper", async () => {
    setAiPolicy("local-only");
    localStorage.setItem("lumen.research.endpoint", "https://worker.example.com");
    const original = window.fetch;
    const inner = fakeFetch();
    window.fetch = inner as unknown as typeof fetch;
    try {
      installPrivacyLedger();
      await expect(window.fetch("https://worker.example.com/search", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PrivacyBlockedError);
      await ledgerFetch({ force: { category: "research", reason: "Agent tool search_web (user consent)" }, consent: true })("https://worker.example.com/search", { method: "POST", body: "{}" });
      expect(inner).toHaveBeenCalledTimes(1);
      expect(ledgerEntries().map((e) => [e.decision, e.consent ?? false, e.reason])).toEqual([
        ["blocked", false, "Research service"],
        ["allowed", true, "Agent tool search_web (user consent)"],
      ]);
    } finally {
      window.fetch = original;
      __resetLedger();
    }
  });

  it("records files the browser loads itself (FontFace, CSS url()) from resource timing", () => {
    setAiPolicy("local-only");
    let deliver: ((list: { getEntries: () => unknown[] }) => void) | null = null;
    const observed: unknown[] = [];
    class FakeObserver {
      constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
        deliver = cb;
      }
      observe(opts: unknown) {
        observed.push(opts);
      }
    }
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    const realFetch = window.fetch;
    try {
      installPrivacyLedger();
      expect(observed).toEqual([{ type: "resource", buffered: true }]);
      // Excalidraw's font fallback CDN (third-party; Lumen serves the fonts itself, plan 4.19).
      const cdn = "https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod";
      deliver!({
        getEntries: () => [
          { name: `${cdn}/fonts/Excalifont/Excalifont-Regular.woff2`, initiatorType: "css", transferSize: 0 }, // FontFace
          { name: `${cdn}/fonts/Virgil/Virgil-Regular.woff2`, initiatorType: "css", transferSize: 4096 }, // CSS url()
          { name: `${cdn}/locales/he-IL.json`, initiatorType: "fetch", transferSize: 900 }, // fetch: the wrapper has it
          { name: `${location.origin}/assets/index.js`, initiatorType: "script", transferSize: 10 }, // the app's own file
          { name: "https://example.org/pic.png", initiatorType: "img", transferSize: 10 }, // not a tracked host
          { name: "https://raw.githubusercontent.com/me/repo/main/diagram.png", initiatorType: "img", transferSize: 10 }, // an image in a note, not a model download
        ],
      });
    } finally {
      window.fetch = realFetch;
      vi.unstubAllGlobals();
    }
    const got = ledgerEntries().map((e) => [e.host, e.category, e.decision, e.bytesIn]);
    expect(got).toEqual([
      ["esm.sh", "third-party", "allowed", null], // size unknown without Timing-Allow-Origin
      ["esm.sh", "third-party", "allowed", 4096],
    ]);
    expect(ledgerSummary()).toMatchObject({ staticAssets: 0, downloads: 0 });
  });

  it("a browser-loaded file carrying data in its query counts as sent", () => {
    setAiPolicy("local-first");
    const e = recordBrowserResource({ name: "https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Excalifont/Excalifont-Regular.woff2?url=https%3A%2F%2Fx%2F", initiatorType: "img", transferSize: 0 });
    expect(e).toMatchObject({ category: "third-party", decision: "allowed", bytesOut: "url=https%3A%2F%2Fx%2F".length });
    expect(ledgerSummary().cloudRequests).toBe(1);
  });
});
