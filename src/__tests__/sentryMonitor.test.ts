/**
 * Plan 12.4 — with consent and a DSN, error reports go out through the
 * privacy ledger ("monitoring") with note content, titles and paths
 * removed. Uses the real `@sentry/browser`; only `fetch` is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/browser";
import { __resetLedger, classify, ledgerEntries, ledgerSummary } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";
import { initTelemetry, setMonitoringConsent, __resetTelemetry, __setMonitoringDsnForTesting } from "../lib/telemetry";
import { flushMonitoring } from "../lib/sentryMonitor";
import { log } from "../lib/logger";

const DSN = "https://publickey@o1.ingest.example.com/42";
const sent: { url: string; body: string }[] = [];
const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = init?.body;
  sent.push({ url: String(input), body: typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array) });
  return new Response("{}", { status: 200 });
});
let consoleSpy: { mockRestore: () => void };

beforeEach(() => {
  localStorage.clear();
  __resetLedger();
  __resetTelemetry();
  setAiPolicy("local-first");
  sent.length = 0;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  __setMonitoringDsnForTesting(DSN);
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  __setMonitoringDsnForTesting(null);
  vi.unstubAllGlobals();
  consoleSpy.mockRestore();
});

describe("the ledger knows the error tracker", () => {
  it("classifies the DSN's host as monitoring, and nothing without a DSN", () => {
    expect(classify("https://o1.ingest.example.com/api/42/envelope/?sentry_key=publickey")).toMatchObject({ host: "o1.ingest.example.com", category: "monitoring" });
    expect(classify("https://o1.ingest.example.com/other")).toBeNull();
    __setMonitoringDsnForTesting("");
    expect(classify("https://o1.ingest.example.com/api/42/envelope/")).toBeNull();
  });

  it("a tracker on the app's own origin claims only its report endpoint", () => {
    // jsdom serves the page from http://localhost:<port>; a DSN may be http only on localhost.
    const base = location.origin;
    __setMonitoringDsnForTesting(`${base.replace("://", "://key@")}/glitchtip/7`);
    expect(classify(`${base}/glitchtip/api/7/envelope/`)).toMatchObject({ category: "monitoring" });
    expect(classify(`${base}/sales.csv`)).toBeNull();
    expect(classify(`${base}/glitchtip/other`)).toBeNull();
  });
});

describe("with consent and a DSN", () => {
  it("a report goes through the ledger with note content, titles and paths removed", async () => {
    setMonitoringConsent(true);
    expect(await initTelemetry()).toBe(true);
    log.error("autosave failed for the body of my secret note", new Error('Could not write Quarterly plan "יומן סודי" to notes/private/diary.md'), { text: "the body of my secret note" });
    expect(await flushMonitoring()).toBe(true);

    expect(sent).toHaveLength(1);
    const url = new URL(sent[0].url);
    expect(url.host).toBe("o1.ingest.example.com");
    expect(url.pathname).toBe("/api/42/envelope/");
    const body = sent[0].body;
    for (const secret of ["Quarterly plan", "יומן", "סודי", "diary", "notes/private", "secret note", "breadcrumbs", "\"request\"", "\"user\""]) {
      expect(body, secret).not.toContain(secret);
    }
    // Unquoted user text in a message can't be told from the app's words: no message goes out at all.
    expect(body).not.toContain("Could not write");
    expect(body).toContain('"type":"Error"');
    expect(body).toContain('"infer_ip":"never"');

    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ host: "o1.ingest.example.com", category: "monitoring", method: "POST", decision: "allowed", status: 200 }),
    ]);
    expect(ledgerEntries()[0].bytesOut).toBeGreaterThan(0);
    expect(ledgerSummary().cloudRequests).toBe(1);
  });

  it("under the local-only policy the report is refused before it leaves, and listed as blocked", async () => {
    setAiPolicy("local-only");
    setMonitoringConsent(true);
    expect(await initTelemetry()).toBe(true);
    log.error(new Error("refused while local-only"));
    await flushMonitoring();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([expect.objectContaining({ category: "monitoring", decision: "blocked" })]);
  });

  it("after the user turns it off, nothing more is sent", async () => {
    setMonitoringConsent(true);
    expect(await initTelemetry()).toBe(true);
    setMonitoringConsent(false);
    log.error(new Error("after turning it off"));
    // An uncaught error reaches the SDK directly (global handlers): beforeSend drops it.
    Sentry.captureException(new Error("uncaught after turning it off"));
    await flushMonitoring();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([]);
  });
});
