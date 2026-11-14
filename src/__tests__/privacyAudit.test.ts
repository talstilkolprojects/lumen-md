/**
 * Plan W2.24, audit mode: the ledger lists every request that leaves the
 * device; the comparison with an outside observer (mitmproxy's HAR,
 * Playwright's request log) catches a request the ledger missed and an
 * observer that wasn't in the path; the per-version page stays in step.
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { __resetLedger, AUDIT_MODE_KEY, ledgerEntries, withLedger } from "../ai/privacyLedger";
import { buildReport, newSigningKey, signReport } from "../privacy/report";
// @ts-expect-error -- plain ESM script module, no types
import { auditVerdict, compareWithReport, harUrls, isLocalHost } from "../../scripts/privacy/compare.mjs";
// @ts-expect-error -- plain ESM script module, no types
import { evaluateAudit } from "../../scripts/privacy/audit.mjs";
// @ts-expect-error -- plain ESM script module, no types
import { changelogVersions, compareVersions, missingVersions, publish, renderTable, replaceTable } from "../../scripts/privacy/publish.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
  __resetLedger();
});
afterEach(() => __resetLedger());

const ok = (async () => new Response("{}", { status: 200, headers: { "content-length": "2" } })) as typeof fetch;

describe("audit mode in the ledger", () => {
  it("lists every request off the device as \"network\", never blocks it, and leaves local ones out", async () => {
    mem.set("lumen.ai.policy", "local-only");
    const f = withLedger(ok);
    await f("https://cdn.example.com/a.js");
    expect(ledgerEntries()).toEqual([]); // not in audit mode: untracked traffic isn't listed
    mem.set(AUDIT_MODE_KEY, "1");
    await f("https://cdn.example.com/a.js", { method: "POST", body: "12345" });
    await f("http://localhost:5173/src/main.tsx");
    await f("http://192.168.1.4:11435/x");
    const list = ledgerEntries();
    expect(list.map((e) => [e.host, e.category, e.decision, e.bytesOut, e.bytesIn])).toEqual([["cdn.example.com", "network", "allowed", 5, 2]]);
    // Cloud AI is still blocked under local-only, audit mode or not.
    await expect(f("https://api.openai.com/v1/models")).rejects.toThrow(/local-only/);
  });
});

async function bundleOf(hosts: Array<{ host: string; category?: string; decision?: "allowed" | "blocked" }>) {
  const t0 = Date.UTC(2026, 10, 10);
  const entries = hosts.map((h, i) => ({ id: i + 1, ts: t0 + i + 1, host: h.host, method: "GET", bytesOut: 0, bytesIn: 0, category: (h.category ?? "network") as "network", reason: "r", policy: "local-only" as const, decision: h.decision ?? ("allowed" as const) }));
  return signReport(buildReport(entries, { startedAt: t0, endedAt: t0 + 1000, policy: "local-only", auditMode: true, version: "0.1.0" }), await newSigningKey());
}

describe("comparing with an outside observer", () => {
  const har = (urls: string[]) => ({ log: { entries: urls.map((url) => ({ request: { url } })) } });

  it("passes when both saw only local traffic", async () => {
    const bundle = await bundleOf([{ host: "api.openai.com", category: "cloud-ai", decision: "blocked" }]);
    const a = evaluateAudit({ bundle, harUrls: harUrls(har(["http://localhost:5173/", "http://localhost:5173/src/main.tsx"])), playwrightUrls: ["http://localhost:5173/"], version: "0.1.0", commit: "abc" });
    expect(a.problems).toEqual([]);
    expect(a.result).toBe("pass");
    expect(a.observers.map((o: { observer: string; requestsSeen: number }) => [o.observer, o.requestsSeen])).toEqual([["mitmproxy", 2], ["playwright", 1]]);
  });

  it("fails on a request the ledger missed, one the observer never saw, and an observer that saw nothing", async () => {
    const quiet = await bundleOf([]);
    const missed = evaluateAudit({ bundle: quiet, harUrls: ["http://localhost:5173/", "https://fonts.example.com/x.woff2"], version: "0.1.0", commit: "abc" });
    expect(missed.result).toBe("fail");
    expect(missed.problems.join("\n")).toMatch(/doesn't list: fonts\.example\.com/);

    const loud = await bundleOf([{ host: "cdn.example.com" }]);
    const unseen = compareWithReport("mitmproxy", ["http://localhost:5173/"], JSON.parse(loud.report));
    expect(unseen.unseen).toEqual(["cdn.example.com"]);
    expect(auditVerdict([unseen]).pass).toBe(false);

    const empty = evaluateAudit({ bundle: quiet, harUrls: [], version: "0.1.0", commit: "abc" });
    expect(empty.problems.join("\n")).toMatch(/not in the path/);
  });

  it("agreeing on a non-local request is still a failed local-only audit", async () => {
    const bundle = await bundleOf([{ host: "cdn.example.com" }]);
    const a = evaluateAudit({ bundle, harUrls: ["http://localhost:5173/", "https://cdn.example.com/a.js"], version: "0.1.0", commit: "abc" });
    expect(a.observers[0].agree).toBe(true);
    expect(a.result).toBe("fail");
    expect(a.problems.join("\n")).toMatch(/1 requests left the device|non-local requests in a local-only run/);
  });

  it("knows local: this device and the LAN", () => {
    for (const h of ["localhost", "127.0.0.1", "127.5.0.1", "::1", "[::1]", "app.localhost", "nas.local", "10.0.0.2", "172.20.1.1", "192.168.0.10"]) expect(isLocalHost(h)).toBe(true);
    for (const h of ["api.openai.com", "8.8.8.8", "172.32.0.1", "fonts.gstatic.com"]) expect(isLocalHost(h)).toBe(false);
  });
});

describe("the page per version", () => {
  const audit = (version: string, result = "pass") => ({ file: `${version}.json`, signed: true, audit: { format: "lumen-privacy-audit/1", version, date: "2026-12-02T10:00:00Z", result, observers: [{ observer: "mitmproxy", requestsSeen: 412, observedNonLocal: [], ledgerNonLocal: [] }] } });

  it("renders a row per audit, newest first, in English and Hebrew", () => {
    const t = renderTable([audit("0.2.0"), audit("0.1.0", "fail")], "en");
    expect(t.split("\n")).toEqual(["| Version | Date | Result | Left the device (proxy / ledger) | Requests the proxy saw | Signed |", "|---|---|---|---|---|---|", "| 0.2.0 | 2026-12-02 | pass | 0 / 0 | 412 | yes |", "| 0.1.0 | 2026-12-02 | FAIL | 0 / 0 | 412 | yes |"]);
    expect(renderTable([audit("0.2.0")], "he")).toContain("| 0.2.0 | 2026-12-02 | עבר |");
    expect(replaceTable("a\n<!-- audits:start -->\nold\n<!-- audits:end -->\nb", "NEW")).toBe("a\n<!-- audits:start -->\nNEW\n<!-- audits:end -->\nb");
  });

  it("every released version since the first audit needs its audit", () => {
    const released = changelogVersions("## [Unreleased]\n## [0.3.0] - 2027-01-01\n## [0.2.0] - 2026-12-01\n## [0.1.0] - 2026-04-26\n");
    expect(released).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
    expect(missingVersions(released, [])).toEqual([]);
    expect(missingVersions(released, [audit("0.2.0")])).toEqual(["0.3.0"]);
    expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
  });

  it("the repo's page is in step with security/privacy-audits/", () => {
    expect(publish(root, { check: true })).toEqual([]);
    expect(readFileSync(join(root, "docs/src/content/docs/security/privacy-report.md"), "utf8")).toContain("<!-- audits:start -->");
  });
});
