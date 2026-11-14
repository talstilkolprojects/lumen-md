/**
 * Plan W2.24: the signed privacy report. Built and signed the way the app
 * does it (src/privacy/report.ts, WebCrypto Ed25519), checked the way the
 * script does it (scripts/privacy/report-core.mjs, Node crypto + the
 * minisign module of plan W1.27), and tampered with every way that matters.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { buildReport, canonicalJson, newSigningKey, publicKeyText, signReport, summarize, type ReportEntry } from "../privacy/report";
import type { LedgerEntry } from "../ai/privacyLedger";
// @ts-expect-error -- plain ESM script module, no types
import { canonicalJson as canonicalMjs, summarize as summarizeMjs, verifyBundle } from "../../scripts/privacy/report-core.mjs";
// @ts-expect-error -- plain ESM script module, no types
import { verifyData } from "../../scripts/supply-chain/minisign.mjs";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
let id = 1;
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ id: id++, ts: T0 + id * 1000, host: "api.openai.com", method: "POST", bytesOut: 120, bytesIn: 40, category: "cloud-ai", reason: "OpenAI", policy: "local-only", decision: "blocked", ...over });

const localOnlyEntries = () => [
  entry({ decision: "blocked", bytesOut: 0, bytesIn: null }),
  entry({ host: "localhost", category: "local-ai", reason: "Ollama (this machine / LAN)", decision: "allowed", bytesOut: 900, bytesIn: 3000 }),
  entry({ host: "api.anthropic.com", reason: "Anthropic (Claude)", decision: "blocked", bytesOut: 0, bytesIn: null }),
];

async function signed(entries: LedgerEntry[], opts: { policy?: "local-only" | "cloud"; summary?: Partial<ReturnType<typeof summarize>> } = {}) {
  const key = await newSigningKey();
  const report = buildReport(entries, { startedAt: T0, endedAt: T0 + 3600_000, policy: opts.policy ?? "local-only", auditMode: true, version: "0.1.0" });
  if (opts.summary) report.summary = { ...report.summary, ...opts.summary };
  return { key, report, bundle: await signReport(report, key) };
}

describe("the signed privacy report", () => {
  it("verifies: who, when, where, how many bytes, and a summary that matches", async () => {
    const { bundle, report, key } = await signed(localOnlyEntries());
    const v = verifyBundle(bundle, { localOnly: true });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(report.entries.map((e) => [e.category, e.host, e.decision, e.leftDevice])).toEqual([
      ["cloud-ai", "api.openai.com", "blocked", false],
      ["local-ai", "localhost", "allowed", false],
      ["cloud-ai", "api.anthropic.com", "blocked", false],
    ]);
    expect(report.summary).toMatchObject({ requests: 3, leftDevice: 0, blocked: 2, bytesOut: 900, bytesIn: 3000, nonLocalHosts: [] });
    // Pinned to the right key it passes; to another key it doesn't.
    expect(verifyBundle(bundle, { pub: await publicKeyText(key.publicRaw) }).ok).toBe(true);
    const other = await newSigningKey();
    expect(verifyBundle(bundle, { pub: await publicKeyText(other.publicRaw) }).ok).toBe(false);
    // It is a real minisign signature (legacy "Ed"): the release tooling's verifier accepts it.
    expect(verifyData(Buffer.from(bundle.report, "utf8"), bundle.minisig, bundle.publicKey)).toMatch(/^lumen-md privacy report 0\.1\.0 .* sha256:[0-9a-f]{64}$/);
  });

  it("refuses an edited report, a lying summary, a non-canonical one, and a session that left the device", async () => {
    const { bundle } = await signed(localOnlyEntries());
    const edited = { ...bundle, report: bundle.report.replace("api.anthropic.com", "api.example.com") };
    expect(verifyBundle(edited).problems.join("\n")).toMatch(/signature/);

    // A summary that hides a request, signed and all: the recomputation catches it.
    const cloud = [entry({ host: "api.openai.com", decision: "allowed", policy: "cloud" })];
    const lying = await signed(cloud, { policy: "cloud", summary: { leftDevice: 0, nonLocalHosts: [] } });
    expect(verifyBundle(lying.bundle).problems).toContain("the summary does not match the entries");

    // Honest but not local-only: fine as a report, not as a local-only audit.
    const honest = await signed(cloud, { policy: "cloud" });
    expect(verifyBundle(honest.bundle).ok).toBe(true);
    expect(verifyBundle(honest.bundle, { localOnly: true }).problems.join("\n")).toMatch(/policy is cloud.*|1 requests left the device: api\.openai\.com/s);

    // Re-serialised (whitespace, key order): the bytes no longer match the signature or the canonical form.
    const pretty = { ...bundle, report: JSON.stringify(JSON.parse(bundle.report), null, 1) };
    expect(verifyBundle(pretty).problems).toContain("the report is not in canonical form");
  });

  it("keeps only this session's entries, in time order; never anything but ledger fields", async () => {
    const before = entry({ ts: T0 - 5000 });
    const later = entry({ ts: T0 + 2000 });
    const earlier = entry({ ts: T0 + 1000 });
    const r = buildReport([before, later, earlier], { startedAt: T0, endedAt: T0 + 10_000, policy: "local-only", version: "x" });
    expect(r.entries.map((e) => e.ts)).toEqual([T0 + 1000, T0 + 2000]);
    expect(Object.keys(r.entries[0]).sort()).toEqual(["bytesIn", "bytesOut", "category", "decision", "host", "leftDevice", "method", "reason", "ts"]);
  });

  it("the app and the script agree on the canonical form and the summary", () => {
    const samples: unknown[] = [null, 0, -1.5, "שלום \"q\"", [1, { b: 2, a: [3, null] }], { z: { y: 1, x: [true, false] }, a: "", m: undefined }];
    for (const s of samples) expect(canonicalJson(s)).toBe(canonicalMjs(s));
    const entries: ReportEntry[] = [
      { ts: 1, category: "model-download", reason: "Model download (Hugging Face)", host: "huggingface.co", method: "GET", bytesOut: 0, bytesIn: 5000, decision: "allowed", leftDevice: true },
      { ts: 2, category: "cloud-ai", reason: "OpenAI", host: "api.openai.com", method: "POST", bytesOut: 10, bytesIn: null, decision: "blocked", leftDevice: false },
      { ts: 3, category: "model-download", reason: "Model download (Hugging Face)", host: "huggingface.co", method: "GET", bytesOut: 0, bytesIn: 7, decision: "allowed", leftDevice: true },
    ];
    expect(summarize(entries)).toEqual(summarizeMjs(entries));
    expect(summarize(entries).nonLocalHosts).toEqual(["huggingface.co"]);
  });
});
