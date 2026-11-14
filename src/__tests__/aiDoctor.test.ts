/**
 * T21 — the AI doctor. A fake Ollama behind `fetch` drives every branch:
 * reachable with the right models → all green; 403 → the OLLAMA_ORIGINS
 * fix; unreachable → the install fix; an embedding-only install → the
 * pull fix with the recommended model. Nothing here talks to the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

type Route = (url: string) => { status: number; body?: unknown } | "offline";

function fakeFetch(route: Route) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = route(url);
    if (r === "offline") throw new TypeError("Failed to fetch");
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
}

const OLLAMA_OK: Route = (url) => {
  if (url.endsWith("/api/version")) return { status: 200, body: { version: "0.6.2" } };
  if (url.endsWith("/api/tags")) return { status: 200, body: { models: [{ name: "qwen2.5:7b", details: { parameter_size: "7.6B", family: "qwen2" } }, { name: "nomic-embed-text:latest", details: { parameter_size: "137M" } }] } };
  if (url.endsWith("/api/show")) return { status: 200, body: { capabilities: ["completion", "tools"] } };
  if (url.includes("/v2/languages")) return { status: 200, body: [] };
  return { status: 404 };
};

const find = (report: Awaited<ReturnType<typeof import("../agents/doctor")["runDoctor"]>>, id: string) => report.findings.find((f) => f.id === id);

describe("runDoctor", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // The Ollama executor caches /api/tags for 30 s; every test starts cold.
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem("lumen.ollama.model", "qwen2.5:7b");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("is all green with a reachable Ollama that has the recommended models", async () => {
    globalThis.fetch = fakeFetch(OLLAMA_OK) as unknown as typeof fetch;
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 500 });
    expect(find(report, "ollama.reach")).toMatchObject({ status: "ok" });
    expect(find(report, "ollama.reach")?.detail).toContain("v0.6.2");
    expect(find(report, "ollama.version")).toMatchObject({ status: "ok" });
    expect(find(report, "ollama.models")).toMatchObject({ status: "ok" });
    expect(find(report, "ollama.embed")).toMatchObject({ status: "ok" });
    expect(find(report, "ollama.configured")).toBeUndefined();
    expect(find(report, "executor")).toMatchObject({ status: "ok", detail: "ollama" });
    expect(report.summary.fail).toBe(0);
    // jsdom has no GPU: the in-browser model is a warning, not a failure, when Ollama works.
    expect(find(report, "webgpu")).toMatchObject({ status: "warn" });
  });

  it("names the exact OLLAMA_ORIGINS fix on a 403", async () => {
    globalThis.fetch = fakeFetch((url) => (url.includes("11434") ? { status: 403 } : OLLAMA_OK(url))) as unknown as typeof fetch;
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 500 });
    const f = find(report, "ollama.cors");
    expect(f).toMatchObject({ status: "fail" });
    expect(f?.fix?.command).toMatch(/OLLAMA_ORIGINS/);
    // jsdom runs on localhost, which the value covers with a wildcard port.
    expect(f?.fix?.command).toContain("http://localhost:*");
    expect(find(report, "ollama.models")).toBeUndefined();
    expect(find(report, "executor")).toMatchObject({ status: "fail" });
    expect(report.summary.fail).toBeGreaterThanOrEqual(2);
  });

  it("points at the installer when Ollama is not running", async () => {
    globalThis.fetch = fakeFetch((url) => (url.includes("11434") ? "offline" : OLLAMA_OK(url))) as unknown as typeof fetch;
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 500 });
    const f = find(report, "ollama.reach");
    expect(f).toMatchObject({ status: "fail" });
    expect(f?.fix?.command).toContain("ollama serve");
    expect(f?.fix?.url).toBe("https://ollama.com/download");
  });

  it("asks for the recommended model when only an embedding model is installed, and flags an old server", async () => {
    globalThis.fetch = fakeFetch((url) => {
      if (url.endsWith("/api/version")) return { status: 200, body: { version: "0.3.9" } };
      if (url.endsWith("/api/tags")) return { status: 200, body: { models: [{ name: "nomic-embed-text:latest" }] } };
      return OLLAMA_OK(url);
    }) as unknown as typeof fetch;
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 500 });
    expect(find(report, "ollama.version")).toMatchObject({ status: "warn" });
    const models = find(report, "ollama.models");
    expect(models).toMatchObject({ status: "fail" });
    expect(models?.fix).toMatchObject({ action: "pullModel", arg: "qwen2.5:7b", command: "ollama pull qwen2.5:7b" });
    expect(find(report, "ollama.embed")).toMatchObject({ status: "ok" });
  });

  it("warns when the configured model is not installed", async () => {
    localStorage.setItem("lumen.ollama.model", "gemma3:12b");
    globalThis.fetch = fakeFetch(OLLAMA_OK) as unknown as typeof fetch;
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 500 });
    expect(find(report, "ollama.configured")).toMatchObject({ status: "warn", detail: "gemma3:12b" });
    expect(find(report, "ollama.configured")?.fix?.command).toBe("ollama pull gemma3:12b");
  });

  it("suggests a tool-calling model for the tool-calling repair on Hebrew notes", async () => {
    localStorage.setItem("lumen.ollama.model", "aya-expanse:8b");
    globalThis.fetch = fakeFetch((url) => {
      if (url.endsWith("/api/tags")) return { status: 200, body: { models: [{ name: "aya-expanse:8b", details: { parameter_size: "8B", family: "cohere" } }] } };
      if (url.endsWith("/api/show")) return { status: 200, body: { capabilities: ["completion"] } };
      return OLLAMA_OK(url);
    }) as unknown as typeof fetch;
    const { useAppStore } = await import("../store/useStore");
    useAppStore.setState({ locale: "he" });
    const { runDoctor } = await import("../agents/doctor");
    const { OLLAMA_CATALOG } = await import("../ai/modelCatalog");
    const report = await runDoctor({ timeoutMs: 500 });
    const f = find(report, "ollama.tools");
    expect(f).toMatchObject({ status: "warn" });
    const arg = f?.fix?.arg as string;
    expect(arg).not.toBe("aya-expanse:8b");
    expect(OLLAMA_CATALOG.find((e) => e.name === arg)?.tools).toBe(true);
  });

  it("refuses a remote Ollama under local-only and offers the settings", async () => {
    localStorage.setItem("lumen.ollama.baseUrl", "http://ollama.example.com:11434");
    globalThis.fetch = fakeFetch(OLLAMA_OK) as unknown as typeof fetch;
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 500 });
    expect(find(report, "ollama.remote")).toMatchObject({ status: "fail", fix: { action: "openSettings" } });
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => String(u).includes("ollama.example.com"))).toBe(false);
  });

  it("reports storage durability with the one-click fix", async () => {
    globalThis.fetch = fakeFetch(OLLAMA_OK) as unknown as typeof fetch;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: async () => ({ usage: 50 * 1024 * 1024, quota: 10 * 1024 * 1024 * 1024 }), persisted: async () => false, persist: async () => true },
    });
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 500 });
    const s = find(report, "storage");
    expect(s).toMatchObject({ status: "warn", fix: { action: "persist" } });
    expect(s?.detail).toContain("evictable");
  });

  it("formats a copyable report with the commands under their findings", async () => {
    globalThis.fetch = fakeFetch((url) => (url.includes("11434") ? { status: 403 } : OLLAMA_OK(url))) as unknown as typeof fetch;
    const { runDoctor, formatDoctorReport } = await import("../agents/doctor");
    const text = formatDoctorReport(await runDoctor({ timeoutMs: 500 }));
    expect(text).toMatch(/^Lumen AI doctor/);
    expect(text).toMatch(/✗ ai\.doctor\.check\.ollama — 403/);
    expect(text).toMatch(/launchctl setenv OLLAMA_ORIGINS/);
    expect(text).toMatch(/fail \d+/);
  });
});

describe("ollamaOriginsFor", () => {
  it("lists the page origin and localhost", async () => {
    const { ollamaOriginsFor } = await import("../agents/doctor");
    expect(ollamaOriginsFor("https://lumen-md.vercel.app")).toBe("https://lumen-md.vercel.app,http://localhost:*");
    expect(ollamaOriginsFor("http://localhost:5173")).toBe("http://localhost:*");
  });
});

describe("compareVersions", () => {
  it("compares dotted versions numerically", async () => {
    const { compareVersions } = await import("../agents/doctor");
    expect(compareVersions("0.5.0", [0, 5, 0])).toBe(0);
    expect(compareVersions("0.10.1", [0, 5, 0])).toBeGreaterThan(0);
    expect(compareVersions("v0.4.9", [0, 5, 0])).toBeLessThan(0);
  });
});
