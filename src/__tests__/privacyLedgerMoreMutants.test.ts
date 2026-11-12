/**
 * Plan W4.17 — more tests for the mutants that survived the privacy ledger's
 * suites: the size cap, request body sizes, worker reports, the clipper's
 * redirects and response sizes, files the browser loads itself, endpoints
 * without a path, and who hears about a block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLedger,
  addSpeechVoiceBytes,
  classify,
  guardedFetch,
  installPrivacyLedger,
  ledgerEntries,
  listenToWorkerLedger,
  recordAppUpdateCheck,
  recordBlockedRequest,
  recordBrowserResource,
  recordPluginRequest,
  withLedger,
  type LedgerEntry,
} from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

const response = (headers: Record<string, string> = {}, extra: Partial<Response> = {}) => ({ status: 200, headers: new Headers(headers), redirected: false, url: "", ...extra }) as unknown as Response;
const okFetch = () => vi.fn(async () => response()) as unknown as typeof fetch;

beforeEach(() => {
  __resetLedger();
  localStorage.clear();
  setAiPolicy("cloud");
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetLedger();
});

describe("privacy ledger, more mutant-killing cases", () => {
  it("keeps the newest 500 entries", () => {
    for (let i = 0; i < 501; i++) recordAppUpdateCheck("updates.example.com", "allowed");
    const list = ledgerEntries();
    expect(list).toHaveLength(500);
    expect(list[0].id).toBe(2);
    expect(list[499].id).toBe(501);
  });

  it("counts form fields and files, and an unknown body as 0 bytes", async () => {
    const f = withLedger(okFetch(), { force: { category: "cloud-ai", reason: "test" } });
    const form = new FormData();
    form.append("a", "abc");
    form.append("file", new Blob(["12345"]), "x.bin");
    await f("https://api.openai.com/v1/x", { method: "POST", body: form });
    await f("https://api.openai.com/v1/y", { method: "POST", body: new ReadableStream() as unknown as BodyInit });
    await f(new Request("https://api.openai.com/v1/z", { method: "PUT" }));
    expect(ledgerEntries().map((e) => [e.method, e.bytesOut])).toEqual([
      ["POST", 8],
      ["POST", 0],
      ["PUT", 0],
    ]);
  });

  it("records what workers report: method and size default, the end fills in the response", () => {
    let handler: ((ev: Event) => void) | null = null;
    listenToWorkerLedger({ addEventListener: (_t: string, h: EventListenerOrEventListenerObject) => (handler = h as (ev: Event) => void) } as Pick<BroadcastChannel, "addEventListener">);
    const send = (data: unknown) => handler!({ data } as MessageEvent);
    send(null);
    send("x");
    send({ kind: "start", id: "1", url: "https://huggingface.co/m.onnx", worker: "w", method: "", bytesOut: 0 });
    send({ kind: "start", id: "2", url: "https://huggingface.co/n.onnx", worker: "w", method: "POST", bytesOut: 7 });
    send({ kind: "start", id: "3", url: "/same-origin.js", worker: "w" });
    send({ kind: "end", id: "1", status: 200, bytesIn: 42 });
    send({ kind: "end", id: "9", status: 500, bytesIn: 1 });
    const list = ledgerEntries();
    expect(list.map((e) => [e.method, e.bytesOut, e.status ?? null, e.bytesIn])).toEqual([
      ["GET", 0, 200, 42],
      ["POST", 7, null, null],
    ]);
    expect(list[0].reason).toMatch(/\(worker: w\)$/);
  });

  it("the clipper's fetch records the size it was told and the site a redirect ended on", async () => {
    const fetchStub = vi.fn(async (url: string) =>
      url.includes("moved") ? response({ "content-length": "12" }, { redirected: true, url: "https://b.example/page" }) : response(url.includes("sized") ? { "content-length": "abc" } : {}, { url }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const as = { category: "research" as const, reason: "Clip a page" };
    await guardedFetch("https://a.example/moved", {}, as);
    await guardedFetch("https://a.example/plain", {}, as);
    await guardedFetch("https://a.example/sized", { method: "post", body: "hello" }, as);
    expect(ledgerEntries().map((e) => [e.host, e.method, e.bytesOut, e.bytesIn, e.reason])).toEqual([
      ["b.example", "GET", 0, 12, "Clip a page (redirected from a.example)"],
      ["a.example", "GET", 0, null, "Clip a page"],
      ["a.example", "POST", 5, null, "Clip a page"],
    ]);
  });

  it("a file the browser loads: query bytes out, transfer size in, unknown when 0", () => {
    const a = recordBrowserResource({ name: "https://esm.sh/font.woff2?v=12345", initiatorType: "css", transferSize: 1 });
    const b = recordBrowserResource({ name: "https://esm.sh/other.woff2", initiatorType: "css", transferSize: 0 });
    expect(a).toMatchObject({ host: "esm.sh", bytesOut: 7, bytesIn: 1 });
    expect(b).toMatchObject({ bytesOut: 0, bytesIn: null });
    expect(recordBrowserResource({ name: "https://esm.sh/x.js", initiatorType: "fetch", transferSize: 9 })).toBe(null);
  });

  it("an endpoint without a path matches only its root, and a bad endpoint matches nothing", () => {
    localStorage.setItem("lumen.grammar.endpoint", "https://lt.example.org");
    expect(classify("https://lt.example.org/")?.category).toBe("cloud-text");
    expect(classify("https://lt.example.org/other")).toBe(null);
    localStorage.setItem("lumen.grammar.endpoint", "http://[");
    expect(classify("https://lt.example.org/")).toBe(null);
  });

  it("only blocks are reported to the app, each with its own entry", () => {
    const seen: LedgerEntry[] = [];
    installPrivacyLedger((e) => seen.push(e));
    setAiPolicy("local-only");
    const blocked = recordPluginRequest("p1", "https://api.example.com/x", "POST", 3);
    setAiPolicy("cloud");
    const allowed = recordPluginRequest("p2", "https://api.example.com/y", "GET", 1);
    recordBlockedRequest("https://api.openai.com/v1/z", "cloud-ai", "Agent tool");
    expect(blocked).toMatchObject({ reason: "Plugin p1", decision: "blocked", bytesOut: 3 });
    expect(allowed).toMatchObject({ reason: "Plugin p2", decision: "allowed" });
    expect(seen.map((e) => e.reason)).toEqual(["Plugin p1", "Agent tool"]);
  });

  it("adding speech bytes to a gone entry says so", () => {
    expect(addSpeechVoiceBytes(12345, 10)).toBe(false);
  });
});
