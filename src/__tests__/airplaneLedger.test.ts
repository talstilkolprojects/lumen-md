/**
 * Review 20, RR20-1: a consented request made through the ledger's own
 * transport (ledgerFetch — the open sources, Sefaria) that is still in
 * flight when airplane mode goes on is counted as in flight and aborted, the
 * same as one made through window.fetch. main.tsx installs the ledger first
 * and airplane mode second; this test does the same.
 */
import { afterEach, describe, expect, it } from "vitest";
import { __resetLedger, installPrivacyLedger, ledgerFetch } from "../ai/privacyLedger";
import { __resetAirplane, egressAttempts, enableAirplaneMode, installAirplaneMode } from "../privacy/airplane";

describe("airplane mode and the ledger's transport (RR20-1)", () => {
  const realFetch = window.fetch;
  afterEach(() => {
    window.fetch = realFetch;
    __resetAirplane();
    __resetLedger();
  });

  it("a ledgerFetch request in flight at the switch is counted and aborted", async () => {
    // A server that answers only when the request is not aborted first.
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response("late")), 2_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal!.reason ?? new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    installPrivacyLedger();
    installAirplaneMode(window as Window & typeof globalThis);
    const pending = ledgerFetch({ force: { category: "cloud-text", reason: "test" }, consent: true })("https://data.gov.il/api/3/action/package_search?q=x").then(
      () => "answered",
      (e: unknown) => `aborted ${(e as Error).name}`,
    );
    await new Promise((r) => setTimeout(r, 20));
    enableAirplaneMode();
    expect(await pending).toMatch(/^aborted/);
    expect(egressAttempts().some((a) => a.decision === "in-flight" && a.target.includes("data.gov.il"))).toBe(true);
  });
});
