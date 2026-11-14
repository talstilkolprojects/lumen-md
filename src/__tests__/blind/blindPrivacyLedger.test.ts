/**
 * Blind tests (plan W6.15, lane B): the privacy ledger (src/ai/privacyLedger.ts).
 *
 * Written from the spec only: docs/src/content/docs/ai/privacy.md, the ledger's
 * description in PR #461 and the public API of privacyLedger.ts and policy.ts
 * (declarations emitted by tsc, no function bodies). The test list (L1–L11) was
 * written before any implementation was read; the implementation was then opened only
 * to check the import paths. Failing cases are `it.fails` entries that link to a
 * finding in the W6.15 findings list (PR body of test/blind-tests).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_MODE_KEY,
  PrivacyBlockedError,
  __resetLedger,
  blockedByPolicy,
  classify,
  clearLedger,
  ledgerEntries,
  ledgerSummary,
  leftDevice,
  recordPluginRequest,
  recordUserShare,
  subscribeLedger,
  withLedger,
} from "../../ai/privacyLedger";
import { setAiPolicy } from "../../ai/policy";

type Call = { url: string; init?: RequestInit };

function fakeFetch(body = "response body") {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

const SECRET_PROMPT = "my-secret-prompt-ת-ז-123456789";
const SECRET_KEY = "sk-secret-api-key-value";

beforeEach(() => {
  __resetLedger();
  localStorage.removeItem(AUDIT_MODE_KEY);
});
afterEach(() => {
  __resetLedger();
  localStorage.removeItem(AUDIT_MODE_KEY);
});

describe("classify and blockedByPolicy (L1, L2, L11)", () => {
  it("cloud AI and model downloads are tracked; this app's own files are not", () => {
    expect(classify("https://api.openai.com/v1/chat/completions")?.category).toBe("cloud-ai");
    expect(classify("https://api.anthropic.com/v1/messages")?.category).toBe("cloud-ai");
    expect(classify("https://huggingface.co/x/resolve/main/model.onnx")?.category).toBe("model-download");
    expect(classify("/assets/index.js")).toBeNull();
    expect(classify(`${location.origin}/manifest.webmanifest`)).toBeNull();
  });

  it("is decided by the real host, not by text that looks like a provider", () => {
    expect(classify("https://api.openai.com.evil.example/v1/chat")?.category).not.toBe("cloud-ai");
    expect(classify("https://evil.example/api.openai.com/v1")?.category).not.toBe("cloud-ai");
    const userinfo = classify("https://api.openai.com@evil.example/v1/chat");
    expect(userinfo?.host ?? "evil.example").toBe("evil.example");
  });

  it("model downloads and static assets are never blocked; cloud AI is under local-only", () => {
    for (const p of ["local-only", "local-first", "cloud"] as const) {
      expect(blockedByPolicy("model-download", p)).toBe(false);
      expect(blockedByPolicy("static-asset", p)).toBe(false);
    }
    expect(blockedByPolicy("cloud-ai", "local-only")).toBe(true);
    expect(blockedByPolicy("cloud-ai", "cloud")).toBe(false);
  });
});

describe("withLedger (L3–L7)", () => {
  it("under local-only a cloud AI request is refused before it leaves, and listed as blocked", async () => {
    setAiPolicy("local-only");
    const { f, calls } = fakeFetch();
    const wrapped = withLedger(f);
    await expect(wrapped("https://api.openai.com/v1/chat/completions", { method: "POST", body: SECRET_PROMPT })).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(calls).toHaveLength(0);
    const [e] = ledgerEntries();
    expect(e.decision).toBe("blocked");
    expect(e.host).toBe("api.openai.com");
    expect(e.policy).toBe("local-only");
    expect(leftDevice(e)).toBe(false);
  });

  it("an allowed request is listed with its sizes, and without its prompt, key, query or response", async () => {
    setAiPolicy("cloud");
    const { f, calls } = fakeFetch("the model's answer");
    const wrapped = withLedger(f);
    const body = JSON.stringify({ prompt: SECRET_PROMPT });
    const res = await wrapped(`https://api.openai.com/v1/chat/completions?key=${SECRET_KEY}`, {
      method: "POST",
      body,
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
    });
    expect(await res.text()).toBe("the model's answer");
    expect(calls).toHaveLength(1);
    const entries = ledgerEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.decision).toBe("allowed");
    expect(e.method).toBe("POST");
    // F-5 (ambiguity, Info): bytesOut also counts the query string (body 45 + "key=…" 27 = 72).
    // The docs say "how many bytes went out", which that reading fits, so: at least the body.
    expect(e.bytesOut).toBeGreaterThanOrEqual(new TextEncoder().encode(body).length);
    expect(leftDevice(e)).toBe(true);
    const json = JSON.stringify(entries);
    for (const s of [SECRET_PROMPT, SECRET_KEY, "the model's answer", "Bearer"]) expect(json).not.toContain(s);
  });

  it("bytesOut counts UTF-8 bytes and binary bodies", async () => {
    setAiPolicy("cloud");
    const { f } = fakeFetch();
    const wrapped = withLedger(f);
    await wrapped("https://api.openai.com/v1/a", { method: "POST", body: "שלום" });
    await wrapped("https://api.openai.com/v1/b", { method: "POST", body: new Uint8Array(1234) });
    const [a, b] = ledgerEntries();
    expect([a.bytesOut, b.bytesOut].sort((x, y) => x - y)).toEqual([8, 1234]);
  });

  it("traffic the ledger doesn't track is not listed", async () => {
    setAiPolicy("local-only");
    const { f, calls } = fakeFetch();
    await withLedger(f)("/assets/app.js");
    await withLedger(f)("https://fonts.example/x.woff2");
    expect(calls).toHaveLength(2);
    expect(ledgerEntries()).toHaveLength(0);
  });

  it("audit mode lists every request that leaves the device as 'network', and blocks none of them", async () => {
    setAiPolicy("local-only");
    localStorage.setItem(AUDIT_MODE_KEY, "1");
    const { f, calls } = fakeFetch();
    const wrapped = withLedger(f);
    await wrapped("https://tiles.example.org/1/2/3.png");
    await wrapped("http://localhost:11434/api/tags");
    await wrapped("http://192.168.1.20:8080/x");
    expect(calls).toHaveLength(3);
    const net = ledgerEntries().filter((e) => e.category === "network");
    expect(net.map((e) => e.host)).toEqual(["tiles.example.org"]);
    expect(net[0].decision).toBe("allowed");
  });

  it("force + consent: listed, marked as consented, not blocked under local-only", async () => {
    setAiPolicy("local-only");
    const { f, calls } = fakeFetch();
    await withLedger(f, { force: { category: "research", reason: "agent tool" }, consent: true })("https://example.com/page");
    expect(calls).toHaveLength(1);
    const [e] = ledgerEntries();
    expect(e.category).toBe("research");
    expect(e.consent).toBe(true);
    expect(e.decision).toBe("allowed");
  });

  it("force without consent under local-only is blocked", async () => {
    setAiPolicy("local-only");
    const { f, calls } = fakeFetch();
    await expect(withLedger(f, { force: { category: "research", reason: "agent tool" } })("https://example.com/page")).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(calls).toHaveLength(0);
  });
});

describe("hand-offs, plugins and the panel (L8–L10)", () => {
  it("a report the user sends is listed as third-party with its size, and nothing is fetched", () => {
    const { f, calls } = fakeFetch();
    void f;
    const e = recordUserShare("https://github.com/talstilkol/lumen-md/issues/new?body=x", 321);
    expect(e?.category).toBe("third-party");
    expect(e?.bytesOut).toBe(321);
    expect(e?.host).toBe("github.com");
    expect(calls).toHaveLength(0);
  });

  it("a plugin's request is blocked under local-only", () => {
    setAiPolicy("local-only");
    const e = recordPluginRequest("demo", "https://api.example.com/x", "GET", 0);
    expect(e.category).toBe("plugin");
    expect(e.decision).toBe("blocked");
  });

  it("subscribers hear every entry; clearLedger empties the list; the summary adds up", async () => {
    let n = 0;
    const off = subscribeLedger(() => n++);
    setAiPolicy("cloud");
    const { f } = fakeFetch();
    await withLedger(f)("https://api.openai.com/v1/x", { method: "POST", body: "abc" });
    setAiPolicy("local-only");
    await withLedger(f)("https://api.openai.com/v1/y").catch(() => undefined);
    expect(n).toBeGreaterThanOrEqual(2);
    const s = ledgerSummary();
    expect(s.total).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.cloudRequests).toBeGreaterThanOrEqual(1);
    expect(s.cloudBytesOut).toBe(3);
    clearLedger();
    expect(ledgerEntries()).toHaveLength(0);
    off();
  });
});
