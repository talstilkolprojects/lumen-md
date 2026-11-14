/**
 * Plan W4.4 / 15.18: which VITE_* variables a build may set.
 *
 * Vite inlines every VITE_* value it is asked for into the public bundle
 * (and, before #243, every VITE_* of the build). The names a build may set
 * are listed in security/vite-env-allowlist.json; anything else fails the
 * build (src/build/viteEnvGate.ts) and the live scan
 * (scripts/secrets-scan-live.mjs). Only names are ever reported, never
 * values.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ALLOWLIST_PATH = fileURLToPath(new URL("../../security/vite-env-allowlist.json", import.meta.url));

/** A CI canary value (scripts/check-vite-secrets.mjs): never a real secret. */
export const CANARY_VALUE = /^ci-canary-[a-z0-9-]+$/;

/** The allowlist file: {names: {NAME: why}, prefixes: {PREFIX: why}}. */
export function loadAllowlist(path = ALLOWLIST_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { names: raw.names ?? {}, prefixes: raw.prefixes ?? {} };
}

/** Whether `name` is on the allowlist (by name or by prefix). */
export function isAllowedViteName(name, allowlist = loadAllowlist()) {
  if (Object.hasOwn(allowlist.names, name)) return true;
  return Object.keys(allowlist.prefixes).some((p) => name.startsWith(p));
}

/**
 * The VITE_* names of `env` with a non-empty value, split into allowed and
 * not allowed. Values are only tested for the canary shape, never returned.
 */
export function checkViteEnv(env, allowlist = loadAllowlist()) {
  const allowed = [];
  const disallowed = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("VITE_")) continue;
    if (value === undefined || value === null || value === "") continue;
    if (isAllowedViteName(name, allowlist) || (typeof value === "string" && CANARY_VALUE.test(value))) allowed.push(name);
    else disallowed.push(name);
  }
  return { allowed: allowed.sort(), disallowed: disallowed.sort() };
}

/** The build error for names not on the allowlist (names only). */
export function formatViteEnvError(disallowed) {
  return (
    `VITE_* variables not on security/vite-env-allowlist.json are set: ${disallowed.join(", ")}.\n` +
    "Vite puts VITE_* values in the public bundle. If one of these is a secret (token, API key, password), " +
    "remove it from the build environment and revoke it with the provider: it may already be public. " +
    "If it is public by design (a URL, a client id), add it to the allowlist with a reason."
  );
}
