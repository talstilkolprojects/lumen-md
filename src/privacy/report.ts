/**
 * A privacy report you can prove (plan W2.24): this session's privacy
 * ledger, exported as a signed file. For every request it says who made it
 * (which feature, and why), when, where it went, and how many bytes went
 * each way. A script checks it later: `node scripts/privacy/verify-report.mjs`.
 *
 * The signature is minisign's Ed25519 format (legacy "Ed": the file itself is
 * signed, which WebCrypto can do without BLAKE2b), so the `minisign` tool
 * verifies it too. The key is this device's own: made on first export, kept
 * in IndexedDB, and the private half can't be read back out (non-extractable).
 * The report includes the public key. A verifier pins it with
 * `--pub` for a device it knows (the audit machine's, for the published
 * audits); without a pin the signature still proves the file wasn't changed
 * after it was signed.
 *
 * What it holds is what the ledger holds: time, host, method, sizes,
 * category, reason, policy, decision. Never a prompt, a note or a header.
 *
 * The summary in the report is checked too: the verifier works it out again
 * from the entries (scripts/privacy/report-core.mjs) and refuses a report
 * whose summary disagrees.
 */

import { ledgerSessionStart, leftDevice, type LedgerEntry } from "../ai/privacyLedger";
import { getAiPolicy, type AiPolicy } from "../ai/policy";

export const REPORT_FORMAT = "lumen-privacy-report/1";
export const BUNDLE_FORMAT = "lumen-privacy-report-bundle/1";

export interface ReportEntry {
  /** When (ms since the epoch). */
  ts: number;
  /** Who: the feature's category and its reason. */
  category: string;
  reason: string;
  /** Where. */
  host: string;
  method: string;
  /** How many bytes went out and came back (null: unknown). */
  bytesOut: number;
  bytesIn: number | null;
  decision: "allowed" | "blocked";
  /** Did it leave this device (allowed, and not to this device or the LAN)? */
  leftDevice: boolean;
}

export interface ReportSummary {
  requests: number;
  leftDevice: number;
  blocked: number;
  bytesOut: number;
  bytesIn: number;
  /** Hosts of the requests that left this device, sorted. Empty: nothing left it. */
  nonLocalHosts: string[];
}

export interface PrivacyReport {
  format: typeof REPORT_FORMAT;
  app: { name: "lumen-md"; version: string };
  session: { startedAt: number; endedAt: number };
  policy: AiPolicy;
  /** Audit mode: the ledger also listed every other request to a non-local host. */
  auditMode: boolean;
  entries: ReportEntry[];
  summary: ReportSummary;
}

export interface ReportBundle {
  format: typeof BUNDLE_FORMAT;
  /** The report, as the exact bytes that were signed (canonical JSON). */
  report: string;
  /** minisign signature of `report`. */
  minisig: string;
  /** minisign public key of the device that signed it. */
  publicKey: string;
}

/** JSON with object keys sorted at every level and no whitespace: the same value gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** The summary of `entries` (the verifier computes the same and compares). */
export function summarize(entries: readonly ReportEntry[]): ReportSummary {
  const left = entries.filter((e) => e.leftDevice);
  return {
    requests: entries.length,
    leftDevice: left.length,
    blocked: entries.filter((e) => e.decision === "blocked").length,
    bytesOut: entries.reduce((n, e) => n + e.bytesOut, 0),
    bytesIn: entries.reduce((n, e) => n + (e.bytesIn ?? 0), 0),
    nonLocalHosts: [...new Set(left.map((e) => e.host))].sort(),
  };
}

export function toReportEntry(e: LedgerEntry): ReportEntry {
  return { ts: e.ts, category: e.category, reason: e.reason, host: e.host, method: e.method, bytesOut: e.bytesOut, bytesIn: e.bytesIn, decision: e.decision, leftDevice: leftDevice(e) };
}

export function appVersion(): string {
  // One name at a time (src/lib/publicEnv.ts): a whole import.meta.env inlines every VITE_* name.
  return (import.meta as ImportMeta & { env?: { VITE_LUMEN_VERSION?: string } }).env?.VITE_LUMEN_VERSION?.trim() || "dev";
}

/** The report of this session (entries since the ledger started in this tab). */
export function buildReport(entries: readonly LedgerEntry[], opts: { startedAt?: number; endedAt?: number; policy?: AiPolicy; auditMode?: boolean; version?: string } = {}): PrivacyReport {
  const startedAt = opts.startedAt ?? ledgerSessionStart();
  const endedAt = opts.endedAt ?? Date.now();
  const list = entries
    .filter((e) => e.ts >= startedAt && e.ts <= endedAt)
    .map(toReportEntry)
    .sort((a, b) => a.ts - b.ts);
  return {
    format: REPORT_FORMAT,
    app: { name: "lumen-md", version: opts.version ?? appVersion() },
    session: { startedAt, endedAt },
    policy: opts.policy ?? getAiPolicy(),
    auditMode: opts.auditMode ?? false,
    entries: list,
    summary: summarize(list),
  };
}

/* ─── Signing (minisign, Ed25519) ──────────────────────────────────────── */

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface SigningKey {
  privateKey: CryptoKey;
  /** The raw 32-byte Ed25519 public key. */
  publicRaw: Uint8Array;
}

/** A new Ed25519 key; the private half can't be exported. */
export async function newSigningKey(): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** The key id minisign shows: the first 8 bytes of SHA-256(public key), as scripts/supply-chain/minisign.mjs makes it. */
async function keyId(pk: Uint8Array): Promise<Uint8Array> {
  return (await sha256(pk)).slice(0, 8);
}

const keyIdHex = (id: Uint8Array) => hex(new Uint8Array(id).reverse()).toUpperCase();

export async function publicKeyText(pk: Uint8Array): Promise<string> {
  const id = await keyId(pk);
  return `untrusted comment: minisign public key ${keyIdHex(id)}\n${b64(concat(enc.encode("Ed"), id, pk))}\n`;
}

/** Sign `text` (its UTF-8 bytes) in minisign's format. */
export async function minisign(text: string, key: SigningKey, trusted: string): Promise<string> {
  if (/[\r\n]/.test(trusted)) throw new Error("The trusted comment must be one line.");
  const data = enc.encode(text);
  const id = await keyId(key.publicRaw);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, data));
  const global = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, concat(sig, enc.encode(trusted))));
  return `untrusted comment: lumen-md privacy report, signed on this device\n${b64(concat(enc.encode("Ed"), id, sig))}\ntrusted comment: ${trusted}\n${b64(global)}\n`;
}

/** Sign a report into a bundle. */
export async function signReport(report: PrivacyReport, key: SigningKey): Promise<ReportBundle> {
  const text = canonicalJson(report);
  const digest = hex(await sha256(enc.encode(text)));
  const trusted = `lumen-md privacy report ${report.app.version} ${new Date(report.session.endedAt).toISOString()} sha256:${digest}`;
  return { format: BUNDLE_FORMAT, report: text, minisig: await minisign(text, key, trusted), publicKey: await publicKeyText(key.publicRaw) };
}

/* ─── This device's key ────────────────────────────────────────────────── */

const KEY_DB = "lumen-privacy";
const KEY_NAME = "report-signing-key";

/** This device's report key: made on first use, then kept in IndexedDB (the private half stays non-extractable). */
export async function deviceSigningKey(): Promise<SigningKey> {
  const { createStore, get, set } = await import("idb-keyval");
  const store = createStore(KEY_DB, "keys");
  const have = await get<SigningKey>(KEY_NAME, store);
  if (have?.privateKey && have.publicRaw) return { privateKey: have.privateKey, publicRaw: new Uint8Array(have.publicRaw) };
  const key = await newSigningKey();
  await set(KEY_NAME, key, store);
  return key;
}

/** Build, sign and download this session's report. Returns the bundle. */
export async function exportPrivacyReport(entries: readonly LedgerEntry[], opts: { auditMode?: boolean } = {}): Promise<ReportBundle> {
  const report = buildReport(entries, { auditMode: opts.auditMode ?? false });
  const bundle = await signReport(report, await deviceSigningKey());
  const blob = new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lumen-privacy-report-${new Date(report.session.endedAt).toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return bundle;
}
