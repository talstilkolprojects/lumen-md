/**
 * Plan W4.17 — the privacy ledger's promises (src/ai/privacyLedger.ts, T37
 * and W2.24) that its other suites left unchecked: the ledger is live from
 * the first install, worker downloads arrive over the ledger channel, audit
 * mode lists only what leaves the device (and never invents a size), a
 * refused or bodiless request is recorded as sending nothing, relative URLs
 * resolve against this page, and each recorder hands back its own entry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetLedger,
  addSpeechVoiceBytes,
  AUDIT_MODE_KEY,
  auditMode,
  classify,
  installPrivacyLedger,
  ledgerEntries,
  recordAppUpdateCheck,
  recordBlockedRequest,
  recordBrowserService,
  recordLanSync,
  recordSpeechVoice,
  refuseIfBlocked,
  setLanSyncBytes,
  withLedger,
} from "../ai/privacyLedger";
import { LEDGER_CHANNEL } from "../ai/workerLedger";
import { setAiPolicy } from "../ai/policy";

const ok = (headers: Record<string, string> = {}) => vi.fn(async () => new Response("{}", { status: 200, headers })) as unknown as typeof fetch;

// No __resetLedger() before this one: the module as the app gets it at startup.
describe("at startup", () => {
  it("the first install wraps fetch and listens to the workers' ledger channel", async () => {
    const g = globalThis as unknown as { window?: { fetch?: typeof fetch } };
    const hadWindow = "window" in g;
    const win = (g.window ??= {} as { fetch?: typeof fetch });
    const prev = win.fetch;
    win.fetch = ok({ "content-length": "2" });
    localStorage.clear();
    setAiPolicy("cloud");
    const channel = new BroadcastChannel(LEDGER_CHANNEL);
    try {
      installPrivacyLedger();
      await win.fetch!("https://api.openai.com/v1/models");
      expect(ledgerEntries().map((e) => [e.host, e.bytesIn])).toEqual([["api.openai.com", 2]]);
      channel.postMessage({ kind: "start", id: "w1", url: "https://huggingface.co/m/resolve/main/model.onnx", method: "GET", bytesOut: 0, worker: "transformers" });
      await vi.waitFor(() => expect(ledgerEntries()).toHaveLength(2), { timeout: 2000 });
      expect(ledgerEntries()[1]).toMatchObject({ host: "huggingface.co", category: "model-download", reason: "Model download (Hugging Face) (worker: transformers)" });
    } finally {
      channel.close();
      win.fetch = prev;
      if (!hadWindow) delete g.window;
      __resetLedger();
    }
  });
});

describe("privacy ledger rules", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    __resetLedger();
    setAiPolicy("cloud");
  });

  it("lists Sefaria with and without www as the Jewish-sources reference", () => {
    for (const host of ["sefaria.org", "www.sefaria.org"]) expect(classify(`https://${host}/api/texts/Genesis.1`), host).toMatchObject({ category: "cloud-text", host });
    expect(classify("https://sefaria.org.example.com/x")).toBeNull();
  });

  it("resolves a relative URL against this page, so this origin's configured service is matched", () => {
    localStorage.setItem("lumen.research.endpoint", `${location.origin}/svc`);
    expect(classify("/svc/search")).toMatchObject({ category: "local-ai", reason: "Research (local service)" });
    expect(classify("/svc/other")).toBeNull();
  });

  it("is not in audit mode when storage can't be read", async () => {
    localStorage.setItem(AUDIT_MODE_KEY, "1");
    expect(auditMode()).toBe(true);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem() {}, removeItem() {}, clear() {} });
    expect(auditMode()).toBe(false);
    await withLedger(ok())("https://cdn.example.com/a.js");
    expect(ledgerEntries()).toEqual([]);
  });

  it("audit mode lists only what leaves over http(s), and leaves an unknown response size unknown", async () => {
    localStorage.setItem(AUDIT_MODE_KEY, "1");
    const inner = ok();
    const f = withLedger(inner);
    await f("http://cdn.example.com/a.js");
    await f("https://cdn.example.com/b.js", { method: "post" });
    await f("http://localhost:5173/src/main.tsx");
    await f("http://10.0.0.7/x");
    await f("data:text/plain,hi");
    await f("blob:https://cdn.example.com/1");
    expect(ledgerEntries().map((e) => [e.host, e.method, e.category, e.bytesIn, e.status])).toEqual([
      ["cdn.example.com", "GET", "network", null, 200],
      ["cdn.example.com", "POST", "network", null, 200],
    ]);
    expect((inner as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(6);
  });

  it("a request refused before it was made sent nothing", () => {
    setAiPolicy("local-only");
    const err = recordBlockedRequest("https://r.example.com/search?q=secret", "research", "Agent tool");
    expect(err.name).toBe("PrivacyBlockedError");
    expect(() => refuseIfBlocked("https://news.example/story?id=1", { category: "third-party", reason: "Web clipper" })).toThrow(/local-only/);
    expect(ledgerEntries().map((e) => [e.host, e.decision, e.bytesOut, e.bytesIn])).toEqual([
      ["r.example.com", "blocked", 0, null],
      ["news.example", "blocked", 0, null],
    ]);
  });

  it("each recorder returns its own entry, the newest of several", () => {
    recordAppUpdateCheck("a.example.com", "allowed");
    const update = recordAppUpdateCheck("updates.example.com", "blocked")!;
    expect(update).toMatchObject({ host: "updates.example.com", decision: "blocked", bytesOut: 0, bytesIn: null, category: "static-asset" });
    recordBrowserService("one.example.com", "first");
    expect(recordBrowserService("speech.example.com", "Web Speech")).toMatchObject({ host: "speech.example.com", reason: "Web Speech", method: "STREAM" });
    const voice = recordSpeechVoice("Google עברית", "he", 10)!;
    expect(voice).toBe(ledgerEntries().at(-1));
    expect(addSpeechVoiceBytes(voice.id, 5)).toBe(true);
    expect(ledgerEntries().at(-1)!.bytesOut).toBe(15);
  });

  it("updates a LAN sync link's bytes, and ignores an id that isn't in the ledger", () => {
    const id = recordLanSync("192.168.1.9");
    setLanSyncBytes(id, 100, 250);
    setLanSyncBytes(id + 1000, 1, 1);
    expect(ledgerEntries().map((e) => [e.id, e.method, e.bytesOut, e.bytesIn])).toEqual([[id, "LAN", 100, 250]]);
  });
});
