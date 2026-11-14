/**
 * Plan 7.4 — the complete AI doctor. On an empty machine (no Ollama, no
 * local services, no converted-model host, nothing downloaded) every row
 * that is not OK names a fix: a command, a one-click action or a link
 * (7.4.1, 7.4.2). The stage-6 engines are checked without a download or a
 * request. With golden cases on, every registered agent gets a row (7.4.3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { EngineProbe } from "../agents/doctorEngines";

vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const EMPTY: Partial<EngineProbe> = {
  convertedBase: () => null,
  registry: async () => new Map(),
  chromeTranslator: () => null,
  englishSpell: async () => true,
  hebrewDictionary: async () => false,
  storage: { getItem: () => null },
};

const offline = vi.fn(async () => {
  throw new TypeError("Failed to fetch");
});

describe("AI doctor on an empty machine (plan 7.4)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only");
    globalThis.fetch = offline as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("gives every row that is not OK a fix", async () => {
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 200, engines: EMPTY });
    const ids = report.findings.map((f) => f.id);
    for (const id of ["ollama.reach", "csp.local", "grammar", "research", "engines.host", "engines.translate", "engines.spellEn", "engines.spellHe", "engines.nikud", "engines.caption", "executor"]) {
      expect(ids, id).toContain(id);
    }
    const missing = report.findings.filter((f) => (f.status === "warn" || f.status === "fail") && !f.fix);
    // jsdom has no WebAssembly threads: that warning is informational (no fix exists in the page).
    expect(missing.map((f) => f.id).filter((id) => id !== "wasm")).toEqual([]);
    for (const f of report.findings) if (f.fix) expect(f.fix.command || f.fix.action || f.fix.url || f.fix.label, f.id).toBeTruthy();
  });

  it("still reports when a browser check never settles: that row says it timed out (W4.2)", async () => {
    const sw = navigator.serviceWorker as ServiceWorkerContainer | undefined;
    const hadSw = !!sw;
    const fake = { getRegistration: () => new Promise<undefined>(() => {}) };
    Object.defineProperty(navigator, "serviceWorker", { value: fake, configurable: true });
    try {
      const { runDoctor } = await import("../agents/doctor");
      const report = await runDoctor({ timeoutMs: 200, localTimeoutMs: 30, engines: EMPTY });
      expect(report.findings.find((f) => f.id === "sw")).toMatchObject({ status: "skip", detail: "timed out after 30 ms" });
      // Everything after it still ran.
      for (const id of ["csp.local", "grammar", "engines.spellEn", "executor"]) expect(report.findings.map((f) => f.id), id).toContain(id);
    } finally {
      if (hadSw) Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
      else delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    }
  });

  it("offers the local services in one click under local-only", async () => {
    const { runDoctor, LOCAL_SERVICES } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 200, engines: EMPTY });
    const grammar = report.findings.find((f) => f.id === "grammar");
    expect(grammar).toMatchObject({ status: "warn", fix: { action: "useLocalServices", command: "docker compose -f docker/local-ai.yml up -d" } });
    const research = report.findings.find((f) => f.id === "research");
    expect(research?.fix?.action).toBe("useLocalServices");
    expect(LOCAL_SERVICES).toEqual({ grammar: "http://localhost:8010/v2/check", research: "http://localhost:8787" });
  });

  it("points at docker when the local services are configured but not running", async () => {
    localStorage.setItem("lumen.grammar.endpoint", "http://localhost:8010/v2/check");
    localStorage.setItem("lumen.research.endpoint", "http://localhost:8787");
    const { runDoctor } = await import("../agents/doctor");
    const report = await runDoctor({ timeoutMs: 200, engines: EMPTY });
    for (const id of ["grammar", "research"]) {
      const f = report.findings.find((x) => x.id === id);
      expect(f?.status, id).toBe("warn");
      expect(f?.fix?.command, id).toBe("docker compose -f docker/local-ai.yml up -d");
      expect(f?.fix?.action, id).toBeUndefined();
    }
  });

  it("checks that the CSP lets the page reach 8010 and 8787", async () => {
    const { runDoctor } = await import("../agents/doctor");
    // No CSP meta in jsdom: everything is allowed.
    expect((await runDoctor({ timeoutMs: 200, engines: EMPTY })).findings.find((f) => f.id === "csp.local")).toMatchObject({ status: "ok" });
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = "default-src 'self'; connect-src 'self' http://localhost:11434";
    document.head.appendChild(meta);
    try {
      vi.resetModules();
      const doctor = await import("../agents/doctor");
      const f = (await doctor.runDoctor({ timeoutMs: 200, engines: EMPTY })).findings.find((x) => x.id === "csp.local");
      expect(f).toMatchObject({ status: "fail" });
      expect(f?.fix?.command).toContain("VITE_CSP_CONNECT_EXTRA=");
      expect(f?.fix?.command).toContain("http://localhost:8010");
      expect(f?.fix?.command).toContain("http://localhost:8787");
    } finally {
      meta.remove();
    }
  });

  it("makes no request to a model host and downloads nothing for the engine checks", async () => {
    offline.mockClear();
    const { engineFindings } = await import("../agents/doctorEngines");
    await engineFindings(EMPTY);
    expect(offline).not.toHaveBeenCalled();
  });
});

describe("stage-6 engines", () => {
  beforeEach(() => vi.resetModules());

  it("says why the converted-model engines are off before 15.9, and how to fix it", async () => {
    const { engineFindings } = await import("../agents/doctorEngines");
    const f = await engineFindings(EMPTY);
    const by = (id: string) => f.find((x) => x.id === id);
    expect(by("engines.host")).toMatchObject({ status: "warn", detail: "CONVERTED_MODELS_BASE = null" });
    expect(by("engines.host")?.fix?.label).toBe("ai.doctor.fix.modelHost");
    expect(by("engines.nikud")).toMatchObject({ status: "warn" });
    expect(by("engines.translate")).toMatchObject({ status: "warn", fix: { label: "ai.doctor.fix.translate" } });
    expect(by("engines.translate")?.detail).toContain("Chrome: absent");
    expect(by("engines.spellEn")).toMatchObject({ status: "ok" });
    expect(by("engines.spellHe")).toMatchObject({ status: "warn", fix: { action: "downloadHebrewDictionary" } });
    expect(by("engines.caption")).toMatchObject({ status: "ok" });
  });

  it("asks for the conversion run when the host is set but the registry has no files", async () => {
    const { engineFindings } = await import("../agents/doctorEngines");
    const f = await engineFindings({ ...EMPTY, convertedBase: () => "https://models.example.org" });
    expect(f.find((x) => x.id === "engines.host")).toMatchObject({ status: "warn", fix: { label: "ai.doctor.fix.modelChecksums" } });
    expect(f.find((x) => x.id === "engines.host")?.fix?.command).toContain("model-convert.yml");
  });

  it("is all green with a host, files, Chrome's translator and both dictionaries", async () => {
    const files = { files: [{ dtype: "q8" }, { dtype: "fp32" }] };
    const { engineFindings } = await import("../agents/doctorEngines");
    const f = await engineFindings({
      convertedBase: () => "https://models.example.org",
      registry: async () => new Map([["opus-mt-en-he", files], ["opus-mt-tc-big-he-en", files], ["nakdimon", files]]),
      chromeTranslator: () => ({ availability: async () => "available" }),
      englishSpell: async () => true,
      hebrewDictionary: async () => true,
      storage: { getItem: (k: string) => (k.startsWith("lumen.caption.ready.") ? "1" : null) },
    });
    expect(f.filter((x) => x.status !== "ok").map((x) => x.id)).toEqual([]);
    expect(f.find((x) => x.id === "engines.translate")?.detail).toContain("Chrome: available");
  });

  it("fails English spelling with a retry when the dictionary does not load", async () => {
    const { engineFindings } = await import("../agents/doctorEngines");
    const f = await engineFindings({ ...EMPTY, englishSpell: async () => { throw new Error("chunk failed"); } });
    expect(f.find((x) => x.id === "engines.spellEn")).toMatchObject({ status: "fail", detail: "chunk failed", fix: { action: "retry" } });
  });

  it("a probe that never settles becomes its own timed-out row; the others still report (W4.2)", async () => {
    const { engineFindings } = await import("../agents/doctorEngines");
    const f = await engineFindings({ ...EMPTY, englishSpell: () => new Promise<boolean>(() => {}) }, { timeoutMs: 30 });
    expect(f.find((x) => x.id === "engines.spellEn")).toMatchObject({ status: "fail", detail: "timed out after 30 ms", fix: { action: "retry" } });
    for (const id of ["engines.host", "engines.translate", "engines.spellHe", "engines.nikud", "engines.caption"]) expect(f.map((x) => x.id), id).toContain(id);
  });

  it("the real English check flags a known misspelling on the main thread", async () => {
    const { engineFindings } = await import("../agents/doctorEngines");
    const { englishSpell: _drop, ...rest } = EMPTY;
    void _drop;
    const f = await engineFindings(rest);
    expect(f.find((x) => x.id === "engines.spellEn")).toMatchObject({ status: "ok" });
  });
});

describe("golden cases cover every agent (7.4.3)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only");
  });

  it("gives each registered agent a row; the ones without a case are skipped, not missing", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = offline as unknown as typeof fetch;
    try {
      const [{ runDoctor }, { listAgents }] = await Promise.all([import("../agents/doctor"), import("../agents/registry")]);
      await import("../agents/defs");
      const report = await runDoctor({ timeoutMs: 200, golden: true, engines: EMPTY });
      const rows = new Set(report.findings.filter((f) => f.id.startsWith("golden.")).map((f) => f.id.slice("golden.".length)));
      for (const a of listAgents()) expect(rows, a.id).toContain(a.id);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the web CSPs allow the local services (7.4.1)", () => {
  it("_headers, the Vercel config and the nginx image allow 8010 and 8787 on localhost and 127.0.0.1", () => {
    // vercel.json is deploy/vercel.base.json read through vercel.ts (#239); the image's nginx is deploy/nginx.conf (#301).
    for (const file of ["public/_headers", "deploy/vercel.base.json", "deploy/nginx.conf"]) {
      const text = readFileSync(file, "utf8");
      for (const host of ["localhost", "127.0.0.1"]) for (const port of [8010, 8787]) expect(text, `${file} ${host}:${port}`).toContain(`http://${host}:${port}`);
    }
  });
});

