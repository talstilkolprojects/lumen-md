/**
 * Checking a Lumen privacy report (plan W2.24), with no package: the
 * signature (minisign, Ed25519, via scripts/supply-chain/minisign.mjs), the
 * report's shape, and its summary, recomputed from the entries. A report
 * whose summary disagrees with its own entries is refused, so the summary
 * can't hide a request the entries list.
 *
 * The app side is src/privacy/report.ts; `canonicalJson` and `summarize`
 * here must give the same result as theirs (src/__tests__/privacyReport.test.ts
 * checks that one against the other).
 */
import { createHash } from "node:crypto";
import { parsePublicKey, keyIdHex, verifyData } from "../supply-chain/minisign.mjs";

export const REPORT_FORMAT = "lumen-privacy-report/1";
export const BUNDLE_FORMAT = "lumen-privacy-report-bundle/1";
const DECISIONS = new Set(["allowed", "blocked"]);
const POLICIES = new Set(["local-only", "local-first", "cloud"]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** Did this entry leave the device? The ledger's own rule: allowed, and not to this device or the LAN. */
export const leftDevice = (e) => e.decision === "allowed" && e.category !== "local-ai";

export function summarize(entries) {
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

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** What is wrong with the report's shape (empty: nothing). */
export function reportProblems(r) {
  const p = [];
  if (!r || typeof r !== "object") return ["not an object"];
  if (r.format !== REPORT_FORMAT) p.push(`format is ${JSON.stringify(r.format)}, not ${REPORT_FORMAT}`);
  if (r.app?.name !== "lumen-md" || typeof r.app?.version !== "string") p.push("app is not lumen-md with a version");
  if (!isCount(r.session?.startedAt) || !isCount(r.session?.endedAt) || r.session.endedAt < r.session.startedAt) p.push("bad session times");
  if (!POLICIES.has(r.policy)) p.push(`unknown policy ${JSON.stringify(r.policy)}`);
  if (typeof r.auditMode !== "boolean") p.push("auditMode is not a boolean");
  if (!Array.isArray(r.entries)) return [...p, "entries is not a list"];
  let last = -Infinity;
  r.entries.forEach((e, i) => {
    const at = `entry ${i}`;
    if (!isCount(e?.ts)) return p.push(`${at}: bad time`);
    if (e.ts < r.session.startedAt || e.ts > r.session.endedAt) p.push(`${at}: outside the session`);
    if (e.ts < last) p.push(`${at}: out of order`);
    last = e.ts;
    for (const k of ["category", "reason", "host", "method"]) if (typeof e[k] !== "string") p.push(`${at}: ${k} is not text`);
    if (!isCount(e.bytesOut)) p.push(`${at}: bad bytesOut`);
    if (e.bytesIn !== null && !isCount(e.bytesIn)) p.push(`${at}: bad bytesIn`);
    if (!DECISIONS.has(e.decision)) p.push(`${at}: bad decision`);
    if (e.leftDevice !== leftDevice(e)) p.push(`${at}: leftDevice says ${e.leftDevice}, the entry says ${leftDevice(e)}`);
  });
  if (p.length === 0 && canonicalJson(r.summary) !== canonicalJson(summarize(r.entries))) p.push("the summary does not match the entries");
  return p;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Verify a report bundle. `pub` pins the signing key (minisign public key
 * text); `localOnly` also requires a local-only session in which nothing left
 * the device. Returns {ok, problems, report, keyId, trusted}.
 */
export function verifyBundle(bundle, { pub, localOnly = false } = {}) {
  const problems = [];
  if (!bundle || bundle.format !== BUNDLE_FORMAT || typeof bundle.report !== "string" || typeof bundle.minisig !== "string" || typeof bundle.publicKey !== "string") {
    return { ok: false, problems: ["not a Lumen privacy report bundle"], report: null, keyId: null, trusted: null };
  }
  let keyId = null;
  try {
    keyId = keyIdHex(parsePublicKey(bundle.publicKey).id);
  } catch (e) {
    problems.push(`public key: ${e.message}`);
  }
  if (pub) {
    try {
      if (keyIdHex(parsePublicKey(pub).id) !== keyId || parsePublicKey(pub).pk.toString("hex") !== parsePublicKey(bundle.publicKey).pk.toString("hex")) problems.push("signed with another key than the pinned one");
    } catch (e) {
      problems.push(`pinned key: ${e.message}`);
    }
  }
  let trusted = null;
  try {
    trusted = verifyData(Buffer.from(bundle.report, "utf8"), bundle.minisig, pub ?? bundle.publicKey);
    if (!trusted.includes(`sha256:${sha256(bundle.report)}`)) problems.push("the trusted comment does not name this report");
  } catch (e) {
    problems.push(`signature: ${e.message}`);
  }
  let report = null;
  try {
    report = JSON.parse(bundle.report);
  } catch {
    problems.push("the report is not JSON");
  }
  if (report) {
    if (canonicalJson(report) !== bundle.report) problems.push("the report is not in canonical form");
    problems.push(...reportProblems(report));
    if (localOnly) {
      if (report.policy !== "local-only") problems.push(`policy is ${report.policy}, not local-only`);
      if (report.summary?.leftDevice !== 0) problems.push(`${report.summary?.leftDevice} requests left the device: ${(report.summary?.nonLocalHosts ?? []).join(", ")}`);
    }
  }
  return { ok: problems.length === 0, problems, report, keyId, trusted };
}

export const reportSha256 = (bundle) => sha256(bundle.report);
