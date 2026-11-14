/**
 * Audit mode's comparison (plan W2.24): what an outside observer saw on the
 * wire (mitmproxy's HAR, or Playwright's own request log) against what the
 * app's signed report says left the device.
 *
 *   unlogged  hosts the observer saw leaving that the report doesn't list:
 *             the ledger missed a request (the audit fails)
 *   unseen    hosts the report lists as having left that the observer never
 *             saw: the observer wasn't in the path (the audit fails)
 *
 * "Local" is this device and the LAN, the same rule as the ledger's
 * (src/ai/policy.ts isLocalOrigin), with all of 127/8 and IPv6 loopback.
 */

export function isLocalHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** The request URLs in a HAR file (mitmproxy's `hardump`). */
export function harUrls(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("Not a HAR file (no log.entries).");
  return entries.map((e) => e?.request?.url).filter((u) => typeof u === "string");
}

const uniqueSorted = (xs) => [...new Set(xs)].sort();

/**
 * Compare one observer's URLs with a verified report.
 * Returns {observer, requestsSeen, observedNonLocal, ledgerNonLocal, unlogged, unseen, agree, zeroNonLocal}.
 */
export function compareWithReport(observer, urls, report) {
  const hosts = urls.map(hostOf).filter((h) => h !== null);
  const observedNonLocal = uniqueSorted(hosts.filter((h) => !isLocalHost(h)));
  const ledgerNonLocal = uniqueSorted(report.entries.filter((e) => e.leftDevice && !isLocalHost(e.host)).map((e) => e.host.toLowerCase()));
  const unlogged = observedNonLocal.filter((h) => !ledgerNonLocal.includes(h));
  const unseen = ledgerNonLocal.filter((h) => !observedNonLocal.includes(h));
  return {
    observer,
    requestsSeen: urls.length,
    observedNonLocal,
    ledgerNonLocal,
    unlogged,
    unseen,
    agree: unlogged.length === 0 && unseen.length === 0,
    zeroNonLocal: observedNonLocal.length === 0 && ledgerNonLocal.length === 0,
  };
}

/**
 * The audit's verdict over every observer: they must each have seen traffic
 * (an observer that saw nothing wasn't in the path), each agree with the
 * report, and, for a local-only audit, show 0 non-local requests.
 */
export function auditVerdict(comparisons, { localOnly = true } = {}) {
  const problems = [];
  for (const c of comparisons) {
    if (c.requestsSeen === 0) problems.push(`${c.observer} saw no requests at all: it was not in the path`);
    if (c.unlogged.length) problems.push(`${c.observer} saw requests the report doesn't list: ${c.unlogged.join(", ")}`);
    if (c.unseen.length) problems.push(`the report lists requests ${c.observer} never saw: ${c.unseen.join(", ")}`);
    if (localOnly && !c.zeroNonLocal) problems.push(`${c.observer}: non-local requests in a local-only run: ${uniqueSorted([...c.observedNonLocal, ...c.ledgerNonLocal]).join(", ")}`);
  }
  return { pass: problems.length === 0 && comparisons.length > 0, problems };
}
