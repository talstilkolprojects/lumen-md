/** T37 — the privacy ledger records AI requests and enforces local-only. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetLedger, classify, leftDevice, ledgerEntries, ledgerSummary, PrivacyBlockedError, subscribeLedger, withLedger } from "../ai/privacyLedger";
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
    await f("https://api.openai.com/v1/x").catch(() => {});
    await f("http://localhost:11434/api/tags");
    setAiPolicy("cloud");
    await f("https://api.openai.com/v1/x");
    expect(ledgerEntries().map(leftDevice)).toEqual([false, false, true]);
  });

  it("tracks tldraw's licence beacon (it carries the page address) and blocks it under local-only (plan 1.9)", async () => {
    const beacon = "https://cdn.tldraw.com/4.5.10/watermarks/watermark-track.svg?license_type=unlicensed&url=https%3A%2F%2Flumen.example%2F";
    expect(classify(beacon)).toMatchObject({ host: "cdn.tldraw.com", category: "third-party" });
    const inner = vi.fn(async () => new Response("<svg/>", { status: 200 }));
    const f = withLedger(inner as unknown as typeof fetch);
    setAiPolicy("local-only");
    await expect(f(beacon)).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(inner).not.toHaveBeenCalled();
    setAiPolicy("local-first");
    await f(beacon);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(ledgerEntries().map((e) => [e.category, e.decision])).toEqual([["third-party", "blocked"], ["third-party", "allowed"]]);
    // the beacon left the device with the page address: the header total counts it
    expect(ledgerSummary().cloudRequests).toBe(1);
  });

  it("lets tldraw's fonts and icons load under local-only — only the beacon path is blocked", async () => {
    const font = "https://cdn.tldraw.com/4.5.10/fonts/IBMPlexSans-Medium.woff2";
    expect(classify(font)).toMatchObject({ host: "cdn.tldraw.com", category: "static-asset" });
    const inner = vi.fn(async () => new Response("x", { status: 200 }));
    const f = withLedger(inner as unknown as typeof fetch);
    setAiPolicy("local-only");
    await f(font);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(ledgerEntries().map((e) => [e.category, e.decision])).toEqual([["static-asset", "allowed"]]);
    expect(ledgerSummary()).toMatchObject({ cloudRequests: 0, downloads: 1 });
    setAiPolicy("local-first");
  });
});
