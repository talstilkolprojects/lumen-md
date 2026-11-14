/**
 * Plan 12.4 — error monitoring is off by default.
 *
 * The SDK mock's factory records when `@sentry/browser` is actually
 * imported, so "no SDK" means the dynamic import never ran, not just that
 * init wasn't called. The tests run in order: the import can only be
 * observed once per file, so the cases that must not load it come first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ sdkLoaded: vi.fn(), init: vi.fn() }));

vi.mock("@sentry/browser", () => {
  h.sdkLoaded();
  return {
    init: h.init,
    globalHandlersIntegration: () => ({ name: "GlobalHandlers" }),
    linkedErrorsIntegration: () => ({ name: "LinkedErrors" }),
    dedupeIntegration: () => ({ name: "Dedupe" }),
    makeFetchTransport: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
  };
});

import { initTelemetry, getMonitoringConsent, setMonitoringConsent, monitoringDsn, monitoringOrigin, __resetTelemetry, __setMonitoringDsnForTesting } from "../lib/telemetry";
import { log } from "../lib/logger";

const DSN = "https://publickey@o1.ingest.example.com/42";
const fetchSpy = vi.fn(async () => new Response("{}"));
let consoleSpy: { mockRestore: () => void };

beforeEach(() => {
  localStorage.clear();
  __resetTelemetry();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  __setMonitoringDsnForTesting(null);
  vi.unstubAllGlobals();
  consoleSpy.mockRestore();
});

describe("fresh state", () => {
  it("is off: no consent, no SDK import, no request — even when the build has a DSN", async () => {
    __setMonitoringDsnForTesting(DSN);
    expect(getMonitoringConsent()).toBe(false);
    expect(await initTelemetry()).toBe(false);
    log.error(new Error("boom"));
    expect(h.sdkLoaded).not.toHaveBeenCalled();
    expect(h.init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the old opt-out flag doesn't turn monitoring on", async () => {
    __setMonitoringDsnForTesting(DSN);
    localStorage.setItem("lumen.telemetry.optOut", "0");
    expect(getMonitoringConsent()).toBe(false);
    expect(await initTelemetry()).toBe(false);
    expect(h.sdkLoaded).not.toHaveBeenCalled();
  });
});

describe("turned on without a DSN", () => {
  it("still loads nothing and sends nothing", async () => {
    __setMonitoringDsnForTesting("");
    setMonitoringConsent(true);
    expect(getMonitoringConsent()).toBe(true);
    expect(await initTelemetry()).toBe(false);
    log.error(new Error("boom"));
    expect(h.sdkLoaded).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a malformed DSN counts as none", () => {
    for (const bad of ["not a url", "https://o1.ingest.example.com/42", "http://key@remote.example.org/1", "https://key@o1.ingest.example.com/", "ftp://key@host/1"]) {
      __setMonitoringDsnForTesting(bad);
      expect(monitoringDsn()).toBeNull();
      expect(monitoringOrigin()).toBeNull();
    }
    __setMonitoringDsnForTesting("http://key@localhost:8000/3");
    expect(monitoringOrigin()).toBe("http://localhost:8000");
  });
});

describe("turned on with a DSN", () => {
  it("imports the SDK once, without replay, tracing or default integrations", async () => {
    __setMonitoringDsnForTesting(DSN);
    localStorage.setItem("lumen.monitoring.consent", "1");
    expect(await initTelemetry()).toBe(true);
    expect(await initTelemetry()).toBe(true);
    expect(h.sdkLoaded).toHaveBeenCalledTimes(1);
    expect(h.init).toHaveBeenCalledTimes(1);
    const opts = h.init.mock.calls[0][0] as {
      dsn: string;
      defaultIntegrations: unknown;
      integrations: { name: string }[];
      sendDefaultPii: boolean;
      maxBreadcrumbs: number;
      tracesSampleRate?: number;
      transport: unknown;
      beforeSend: (e: unknown) => unknown;
    };
    expect(opts.dsn).toBe(DSN);
    expect(opts.defaultIntegrations).toBe(false);
    expect(opts.integrations.map((i) => i.name).sort()).toEqual(["Dedupe", "GlobalHandlers", "LinkedErrors"]);
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.maxBreadcrumbs).toBe(0);
    expect(opts.tracesSampleRate).toBeUndefined();
    expect(typeof opts.transport).toBe("function");

    // beforeSend scrubs while consent holds, and drops everything once it is withdrawn.
    const event = {
      type: undefined,
      exception: { values: [{ type: "Error", value: "Could not open Diary" }] },
      request: { url: "https://lumen-md.vercel.app/#notes/diary.md" },
      user: { id: "u1" },
    };
    expect(opts.beforeSend(event)).toEqual({ type: undefined, exception: { values: [{ type: "Error" }] } });
    setMonitoringConsent(false);
    expect(opts.beforeSend(event)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
