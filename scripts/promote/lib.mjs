/**
 * Plan W6.6: no promotion of main without a WebKit receipt and a Safari
 * receipt for the same commit. Pure functions; scripts/promote/check.mjs
 * reads git, the receipts repository and the keys.
 *
 * A receipt counts for a candidate commit when:
 *   - it is sealed and its Ed25519 signature verifies with one of the
 *     trusted host keys (scripts/nightly/receipt.mjs; the factory signs
 *     with keys/<host>.pem in talstilkol/lumen-md-receipts)
 *   - it is for the candidate's commit, or for a commit with the very same
 *     tree (a merge of the train into main that changes nothing else)
 *   - WebKit: a "full" receipt (W6.5) whose "e2e webkit" suite passed, and
 *     whose data-safety drill passed when it ran
 *   - Safari: a "full" receipt with passing "safari …" suites, or a "safari"
 *     receipt (scripts/safari/run.mjs) whose platforms all passed; it must
 *     cover a real iOS device and macOS
 */

export const WEBKIT_SUITE = "e2e webkit";
export const SAFARI_NEEDS = ["ios", "macos"];

/** "safari ios 18 (iPhone 16)" → "ios"; "safari macos sequoia" → "macos". */
export const safariKind = (name) => (/^safari\s+ios\b/i.test(name) ? "ios" : /^safari\s+mac(os)?\b/i.test(name) ? "macos" : null);

/**
 * The Safari platforms a receipt proves: [{ kind, name, ok }]. From a full
 * receipt's "safari …" suites, or from a safari receipt's platforms.
 */
export function safariPlatforms(r) {
  if (r?.kind === "safari") return (r.platforms ?? []).map((p) => ({ kind: safariKind(`safari ${p.os ?? ""}`) ?? safariKind(p.name ?? ""), name: p.name, ok: p.ok === true }));
  return Object.entries(r?.suites ?? {})
    .filter(([name]) => safariKind(name))
    .map(([name, s]) => ({ kind: safariKind(name), name, ok: s.ok === true }));
}

/**
 * The verdict for one candidate.
 *   candidate: the commit sha to promote
 *   receipts:  [{ path, report, verified: { ok, problems } }]
 *   sameTree(a, b): true when commits a and b have the same tree
 * → { ok, webkit: { ok, by?, why[] }, safari: { ok, by?, platforms, why[] } }
 */
export function promotionVerdict(candidate, receipts, sameTree = (a, b) => a === b) {
  const forCommit = receipts.filter((x) => x.report?.commit?.sha && (x.report.commit.sha === candidate || sameTree(x.report.commit.sha, candidate)));
  const webkit = { ok: false, why: [] };
  const safari = { ok: false, platforms: [], why: [] };
  if (!forCommit.length) {
    const why = `no receipt for ${candidate.slice(0, 9)} or a commit with the same tree`;
    return { ok: false, webkit: { ok: false, why: [why] }, safari: { ok: false, platforms: [], why: [why] } };
  }
  const seen = new Map();
  for (const x of forCommit) {
    const r = x.report;
    const label = x.path;
    if (!x.verified?.ok) {
      webkit.why.push(`${label}: not counted, ${x.verified?.problems?.join("; ") || "not verified"}`);
      safari.why.push(`${label}: not counted, ${x.verified?.problems?.join("; ") || "not verified"}`);
      continue;
    }
    if (r.kind === "full") {
      const w = r.suites?.[WEBKIT_SUITE];
      const drill = r.suites?.["drill-data-safety"];
      if (!w) webkit.why.push(`${label}: WebKit did not run`);
      else if (!w.ok) webkit.why.push(`${label}: WebKit failed (${w.detail})`);
      else if (drill && !drill.ok) webkit.why.push(`${label}: WebKit passed, but the data-safety drill failed (${drill.detail})`);
      else if (!webkit.ok) Object.assign(webkit, { ok: true, by: label, detail: w.detail });
    }
    for (const p of safariPlatforms(r)) {
      if (!p.kind) continue;
      const prev = seen.get(p.name);
      // A later receipt of the same platform replaces an earlier one only when it passed.
      if (!prev || (!prev.ok && p.ok)) seen.set(p.name, { ...p, by: label });
    }
  }
  safari.platforms = [...seen.values()];
  for (const need of SAFARI_NEEDS) {
    const ps = safari.platforms.filter((p) => p.kind === need);
    if (!ps.length) safari.why.push(`no Safari ${need === "ios" ? "iOS (real device)" : "macOS"} run`);
    else if (!ps.some((p) => p.ok)) safari.why.push(`Safari ${need} failed: ${ps.map((p) => p.name).join(", ")}`);
  }
  const failedAny = safari.platforms.filter((p) => !p.ok);
  if (failedAny.length) safari.why.push(`failed: ${failedAny.map((p) => p.name).join(", ")}`);
  safari.ok = SAFARI_NEEDS.every((need) => safari.platforms.some((p) => p.kind === need)) && failedAny.length === 0;
  if (!webkit.ok && !webkit.why.length) webkit.why.push("no full receipt with a WebKit run");
  return { ok: webkit.ok && safari.ok, webkit, safari };
}

/** The verdict as lines for the terminal. */
export function verdictLines(candidate, v) {
  const o = [`promote:check ${candidate.slice(0, 12)}`];
  o.push(`  ${v.webkit.ok ? "✓" : "✗"} WebKit${v.webkit.ok ? `: ${v.webkit.detail} (${v.webkit.by})` : ""}`);
  if (!v.webkit.ok) for (const w of v.webkit.why) o.push(`      ${w}`);
  o.push(`  ${v.safari.ok ? "✓" : "✗"} Safari${v.safari.platforms.length ? `: ${v.safari.platforms.map((p) => `${p.ok ? "✓" : "✗"} ${p.name}`).join(", ")}` : ""}`);
  if (!v.safari.ok) for (const w of v.safari.why) o.push(`      ${w}`);
  o.push(v.ok ? "✓ promote:check: main may be promoted to this commit" : "✗ promote:check: refused — main is not promoted without a WebKit and a Safari receipt for this commit (plan W6.6)");
  return o;
}
