/**
 * Plan W4.4: find token-shaped strings and inlined VITE_* values in built
 * JavaScript, local (dist/) or live (a deployment's URL).
 *
 * Two levels:
 *   secret  a provider token shape (OpenAI / Anthropic sk-, GitHub ghp_ and
 *           friends, Google AIza, AWS, Stripe live keys, Slack, a private
 *           key body, a JWT that is not a public anon key), or a VITE_*
 *           value whose name is not on security/vite-env-allowlist.json.
 *           Any of these fails the scan.
 *   review  hex runs of 32+ characters and anon JWTs: listed for a person
 *           to look at (content hashes, embed ids and test vectors look
 *           the same), never a failure on their own.
 *
 * Reports never carry a full value: masked() keeps the first 4 characters
 * and the length.
 */
import { isAllowedViteName, loadAllowlist } from "./viteEnvAllowlist.mjs";

/** Token shapes. `id` names the provider in reports. */
export const TOKEN_PATTERNS = [
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { id: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "stripe-live-key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { id: "slack-token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  // The header alone is in every PEM parser; a key needs its base64 body.
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\s)+[A-Za-z0-9+/=]{64,}/g },
];

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;
const HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g;
const STR = String.raw`(?:\x60([^\x60]*)\x60|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`;
/** `VITE_X:"value"` — a key of an inlined import.meta.env object. */
const ENV_OBJECT_KEY = new RegExp(String.raw`\b(VITE_[A-Z0-9_]+)\s*:\s*${STR}`, "g");
/** `case"VITE_X":return"value"` — src/lib/publicEnv.ts after inlining. */
const ENV_SWITCH = new RegExp(String.raw`case\s*[\x60"'](VITE_[A-Z0-9_]+)[\x60"']\s*:\s*return\s*${STR}`, "g");

/** First 4 characters and the length: enough to find it, not to use it. */
export function masked(value) {
  return value.length <= 8 ? `${"*".repeat(value.length)} (${value.length})` : `${value.slice(0, 4)}… (${value.length} chars)`;
}

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(part, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Text around a finding, with every long token-like run cut out, so no part of a value is reported. */
function lineContext(text, index, len) {
  const clean = (s) => s.replace(/\s+/g, " ").replace(/[A-Za-z0-9_+/=.-]{16,}/g, "…");
  return `${clean(text.slice(Math.max(0, index - 40), index))}[…]${clean(text.slice(index + len, index + len + 20))}`;
}

/**
 * Findings in one file's text: [{level, kind, file, value (masked), context}],
 * plus `viteEnv`: every inlined VITE_* name with whether it is allowed and set.
 */
export function scanText(file, text, allowlist = loadAllowlist()) {
  const findings = [];
  const seen = new Set();
  const add = (level, kind, raw, index) => {
    const key = `${kind}\0${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ level, kind, file, value: masked(raw), context: lineContext(text, index, raw.length) });
  };
  for (const { id, re } of TOKEN_PATTERNS) {
    for (const m of text.matchAll(re)) add("secret", id, m[0], m.index);
  }
  for (const m of text.matchAll(JWT)) {
    const payload = decodeJwtPayload(m[0]);
    if (!payload) continue;
    const anon = payload.role === "anon";
    add(anon ? "review" : "secret", anon ? "jwt-anon" : "jwt", m[0], m.index);
  }
  for (const m of text.matchAll(HEX)) add("review", "hex32", m[0], m.index);

  const viteEnv = new Map();
  for (const re of [ENV_OBJECT_KEY, ENV_SWITCH]) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      const allowed = isAllowedViteName(name, allowlist);
      const prev = viteEnv.get(name);
      viteEnv.set(name, { name, allowed, set: (prev?.set ?? false) || value !== "" });
      if (!allowed && value !== "") add("secret", "vite-unlisted", value, m.index + m[0].lastIndexOf(value));
    }
  }
  return { findings, viteEnv: [...viteEnv.values()] };
}

/** Same-origin asset paths referenced by an HTML page or a JS chunk. */
export function assetRefs(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:src|href)\s*=\s*"(\/[^"?#]+\.(?:m?js|css))"/g)) out.add(m[1]);
  for (const m of text.matchAll(/(?:\.\/|\/assets\/|\bassets\/)([A-Za-z0-9_~.-]+\.m?js)\b/g)) out.add(`/assets/${m[1]}`);
  return [...out];
}

/** Merge several scanText results (one target). */
export function mergeScans(scans) {
  const findings = scans.flatMap((s) => s.findings);
  const viteEnv = new Map();
  for (const s of scans) {
    for (const v of s.viteEnv) {
      const prev = viteEnv.get(v.name);
      viteEnv.set(v.name, { ...v, set: (prev?.set ?? false) || v.set });
    }
  }
  return { findings, viteEnv: [...viteEnv.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
