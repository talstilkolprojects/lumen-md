/**
 * Feature-flag rules (plan 14.4), shared by scripts/check-flags.mjs, the
 * release script and their tests. The registry is src/flags/flags.json.
 *
 * The rule that makes "a new feature reaches beta before stable" true:
 *  - every flag names the first beta that had it (`since.beta`);
 *  - a flag is promoted to `stable` only with `since.stable`, a release
 *    later than `since.beta`.
 *
 * Stage "experimental" (plan W11.S1) is off in every channel, beta too. A
 * flag with `requiresAudit: "crypto"` (the encrypted sync) must stay
 * experimental until security/crypto-audit.json names a published external
 * audit: its report URL, the date and the auditor.
 */
import { compareVersions, parseVersion } from "./release.mjs";

const ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Problems with the registry, as messages; empty when it is fine. `keys` is the set of i18n keys (English). */
export function checkFlags(registry, { keys = null, he = null, audit = null } = {}) {
  const out = [];
  const seen = new Set();
  const flags = Array.isArray(registry?.flags) ? registry.flags : null;
  if (!flags) return ["flags.json has no `flags` list"];
  for (const f of flags) {
    const where = `flag ${f?.id ?? "(no id)"}`;
    if (typeof f?.id !== "string" || !ID.test(f.id)) out.push(`${where}: id must look like area.name`);
    if (seen.has(f.id)) out.push(`${where}: listed twice`);
    seen.add(f.id);
    if (f.stage !== "experimental" && f.stage !== "beta" && f.stage !== "stable") out.push(`${where}: stage must be "experimental", "beta" or "stable"`);
    if (f.requiresAudit !== undefined) {
      if (f.requiresAudit !== "crypto") out.push(`${where}: requiresAudit must be "crypto"`);
      else if (f.stage !== "experimental" && !auditPublished(audit)) out.push(`${where}: stays "experimental" until security/crypto-audit.json names a published external audit report`);
    }
    const beta = f.since?.beta;
    const stable = f.since?.stable;
    const valid = (v) => {
      try {
        parseVersion(v);
        return true;
      } catch {
        return false;
      }
    };
    if (!beta || !valid(beta) || !/-beta\.\d+$/.test(beta)) out.push(`${where}: since.beta must be the first beta that had it (x.y.z-beta.n)`);
    if (f.stage === "stable") {
      if (!stable || !valid(stable) || /-/.test(stable)) out.push(`${where}: a stable flag needs since.stable, the release that turned it on`);
      else if (beta && valid(beta) && compareVersions(beta, stable) >= 0) out.push(`${where}: reached stable (${stable}) without an earlier beta (${beta})`);
    } else if (stable) out.push(`${where}: a ${f.stage} flag has no since.stable yet`);
    for (const k of [`flag.${f.id}.name`, `flag.${f.id}.desc`]) {
      if (keys && !keys.has(k)) out.push(`${where}: no English string ${k}`);
      if (he && !he[k]) out.push(`${where}: no Hebrew string ${k}`);
    }
  }
  return out;
}

/** A published external audit: a report at an https URL, the auditor and the date. */
export function auditPublished(audit) {
  const r = audit?.external;
  return !!r && typeof r.report === "string" && /^https:\/\//.test(r.report) && typeof r.auditor === "string" && r.auditor.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "");
}

/** The flags still in beta (for `release.mjs plan --beta` and the release notes). */
export const betaFlags = (registry) => (registry?.flags ?? []).filter((f) => f.stage === "beta").map((f) => f.id);
