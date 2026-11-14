/**
 * Plan 0.15 — tests written for mutants that survived the privacy-ledger
 * suite: every Hugging Face host is a model download, request sizes by body
 * type, the entry each recorder returns is its own, speech bytes add up, and
 * the summary's totals.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetLedger,
  PrivacyBlockedError,
  addSpeechVoiceBytes,
  installPrivacyLedger,
  classify,
  ledgerEntries,
  ledgerSummary,
  recordSpeechRecognition,
  recordSpeechVoice,
  recordWorkerRequest,
  withLedger,
} from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

const ok = (headers: Record<string, string> = { "content-length": "2" }) => async () => new Response("ok", { status: 200, headers });

describe("privacy ledger, mutant-killing cases", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // why: no localStorage in this environment: nothing to clear
      /* no storage */
    }
    __resetLedger();
    setAiPolicy("cloud");
  });

  it("treats every Hugging Face host as a model download", () => {
    for (const h of ["huggingface.co", "cdn-lfs.huggingface.co", "hf.co", "cas-bridge.xethub.hf.co"]) {
      expect(classify(`https://${h}/x`)?.category, h).toBe("model-download");
    }
    expect(classify("https://nothuggingface.co/x")).toBe(null);
    expect(classify("https://evilhf.co/x")).toBe(null);
  });

  it("counts a research service by its path, not anything with 'search' in it", () => {
    expect(classify("https://searx.example.org/search?q=x")?.category).toBe("research");
    expect(classify("https://research.example.org/extract")?.category).toBe("research");
    expect(classify("https://searx.example.org/searching")).toBe(null);
    expect(classify("https://example.org/search?q=x")).toBe(null);
  });

  it("measures the request body of every kind", async () => {
    const f = withLedger(ok() as unknown as typeof fetch);
    const url = "https://api.openai.com/v1/x";
    await f(url, { method: "post", body: new ArrayBuffer(10) });
    await f(url, { method: "POST", body: new Uint8Array(7) });
    await f(url, { method: "POST", body: new URLSearchParams({ a: "bc" }) });
    await f(url, { method: "POST", body: new Blob(["abcd"]) });
    if (typeof FormData !== "undefined") {
      const fd = new FormData();
      fd.append("a", "xyz");
      fd.append("b", "12");
      await f(url, { method: "POST", body: fd });
    }
    await f(url);
    const sizes = ledgerEntries().map((e) => e.bytesOut);
    expect(sizes.slice(0, 4)).toEqual([10, 7, 4, 4]);
    if (typeof FormData !== "undefined") expect(sizes[4]).toBe(5);
    expect(sizes[sizes.length - 1]).toBe(0);
    expect(ledgerEntries()[0].method).toBe("POST");
    expect(ledgerEntries()[ledgerEntries().length - 1].method).toBe("GET");
  });

  it("leaves bytesIn unknown without a content-length", async () => {
    const f = withLedger(ok({}) as unknown as typeof fetch);
    await f("https://api.openai.com/v1/x");
    expect(ledgerEntries()[0].bytesIn).toBe(null);
    expect(ledgerEntries()[0].status).toBe(200);
  });

  it("returns each recorder's own entry, with increasing ids", () => {
    const a = recordWorkerRequest("https://huggingface.co/m.onnx")!;
    const b = recordWorkerRequest("https://raw.githubusercontent.com/d.dic", "HEAD")!;
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(b.method).toBe("HEAD");
    expect(b.host).toBe("raw.githubusercontent.com");
    expect(recordWorkerRequest("https://example.org/x")).toBe(null);
    const v = recordSpeechVoice("Google עברית", "he", 30)!;
    const r = recordSpeechRecognition("blocked")!;
    expect(v.id).toBe(3);
    expect(r.id).toBe(4);
    expect(r.decision).toBe("blocked");
  });

  it("adds a sentence's bytes to the same voice entry", () => {
    const v = recordSpeechVoice("Voice", "en", 30)!;
    recordSpeechVoice("Other", "en", 5);
    addSpeechVoiceBytes(v.id, 12);
    addSpeechVoiceBytes(999, 50);
    expect(ledgerEntries().map((e) => e.bytesOut)).toEqual([42, 5]);
  });

  it("sums cloud bytes and counts downloads in the summary", () => {
    recordSpeechVoice("Voice", "en", 30);
    recordSpeechVoice("Voice", "en", 12);
    recordWorkerRequest("https://huggingface.co/m.onnx");
    recordWorkerRequest("https://cdn-lfs.huggingface.co/repo/model.bin");
    recordSpeechRecognition("blocked");
    const s = ledgerSummary();
    expect(s).toMatchObject({ total: 5, blocked: 1, cloudRequests: 2, cloudBytesOut: 42, downloads: 2, local: 0 });
  });

  it("starts ids from 1 again after a reset", () => {
    recordSpeechVoice("Voice", "en", 1);
    __resetLedger();
    expect(recordSpeechVoice("Voice", "en", 1)!.id).toBe(1);
  });

  it("records nothing sent for a worker request and a blocked one", async () => {
    expect(recordWorkerRequest("https://huggingface.co/m.onnx")!.bytesOut).toBe(0);
    setAiPolicy("local-only");
    const f = withLedger(ok() as unknown as typeof fetch);
    await expect(f("https://api.openai.com/v1/x", { method: "POST", body: "secret" })).rejects.toThrow(PrivacyBlockedError);
    const blocked = ledgerEntries()[1];
    expect(blocked).toMatchObject({ decision: "blocked", bytesOut: 0, method: "POST" });
  });

  it("takes a Request's own method", async () => {
    const f = withLedger(ok() as unknown as typeof fetch);
    await f(new Request("https://api.openai.com/v1/x", { method: "PUT", body: "x" }));
    expect(ledgerEntries()[0].method).toBe("PUT");
  });

  it("installs once, keeps the last entries from storage and goes on numbering after them", async () => {
    const g = globalThis as unknown as { window?: { fetch?: typeof fetch } };
    const hadWindow = "window" in g;
    const win = (g.window ??= {} as { fetch?: typeof fetch });
    const prevFetch = win.fetch;
    let calls = 0;
    win.fetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    localStorage.setItem(
      "lumen.privacy.ledger",
      JSON.stringify([{ id: 5, host: "a" }, null, "x", { id: 9 }, { id: 7, host: "b" }]),
    );
    const blockedSeen: unknown[] = [];
    try {
      installPrivacyLedger((e) => blockedSeen.push(e));
      installPrivacyLedger();
      expect(ledgerEntries().map((e) => e.host)).toEqual(["a", "b"]);
      setAiPolicy("local-only");
      await expect(win.fetch!("https://api.openai.com/v1/x")).rejects.toThrow(PrivacyBlockedError);
      expect(blockedSeen.length).toBe(1);
      expect(ledgerEntries()[2].id).toBe(8);
      setAiPolicy("cloud");
      await win.fetch!("https://api.openai.com/v1/x");
      expect(calls).toBe(1);
      expect(ledgerEntries().length).toBe(4);
    } finally {
      win.fetch = prevFetch;
      if (!hadWindow) delete g.window;
    }
  });
});

