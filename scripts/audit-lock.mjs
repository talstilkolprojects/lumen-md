#!/usr/bin/env node
/**
 * Known-bad dependency versions gate (plan 2.8 / 12.2). Works offline.
 *
 * Reads security/known-bad.json and checks each entry against the file it
 * names: an npm package-lock.json (v2/v3 `packages`), a Cargo.lock, or a
 * package.json (for a range that no lockfile pins, such as the plugin
 * template's: the lowest version the declared range allows is checked).
 *
 *   status "fixed"  a bad version in the file fails the check (a regression).
 *   status "open"   the bad version is still there and waits for an owner
 *                   step (`fix`). It is reported, not failed, until `expires`
 *                   (at most 90 days from today). It fails once expired, and
 *                   it fails as stale once the bad version is gone, so the
 *                   list stays exact.
 *
 * Unlike scripts/audit-gate.mjs (npm audit / cargo audit, which need the
 * network), this needs nothing but the repo, so it runs in `npm run hygiene`.
 *
 *   node scripts/audit-lock.mjs          check (exit 1 on any error)
 *   node scripts/audit-lock.mjs --json   print the findings as JSON
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_OPEN_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** [major, minor, patch, prerelease] of "1.2.3" / "1.2.3-beta.1", or null. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** Negative, zero or positive, like a sort comparator. A prerelease sorts before its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/**
 * Whether `version` is in `range`: comparators (`<`, `<=`, `>`, `>=`, `=`
 * or a bare version) joined by spaces (and) and `||` (or). No carets or
 * tildes: a bad-version range is written out in full.
 */
export function inRange(version, range) {
  return String(range)
    .split("||")
    .some((alt) => {
      const parts = alt.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) throw new Error(`empty range alternative in "${range}"`);
      return parts.every((c) => {
        const m = /^(<=|>=|<|>|=)?(.+)$/.exec(c);
        if (!m || !parseVersion(m[2])) throw new Error(`bad comparator "${c}" in "${range}"`);
        const d = compareVersions(version, m[2]);
        return { "<": d < 0, "<=": d <= 0, ">": d > 0, ">=": d >= 0, "=": d === 0, undefined: d === 0 }[m[1]];
      });
    });
}

/** The lowest version a package.json range allows ("^5.0.0" → "5.0.0"), or null for one this can't read. */
export function rangeFloor(spec) {
  const first = String(spec).split("||").map((s) => s.trim()).filter(Boolean);
  const floors = first
    .map((alt) => {
      const m = /^(?:\^|~|>=|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(-[0-9A-Za-z.-]+)?(?:\s|$)/.exec(alt);
      if (!m) return null;
      const n = (s) => (s === undefined || s === "x" || s === "*" ? "0" : s);
      return `${m[1]}.${n(m[2])}.${n(m[3])}${m[4] ?? ""}`;
    })
    .filter(Boolean);
  if (floors.length !== first.length || floors.length === 0) return null;
  return floors.sort(compareVersions)[0];
}

/** [{ name, version, where }] of an npm lockfile (v2/v3). */
export function npmLockVersions(lock) {
  const out = [];
  for (const [path, e] of Object.entries(lock.packages ?? {})) {
    if (!path || e.link || !e.version) continue;
    const name = e.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    out.push({ name, version: e.version, where: path });
  }
  return out;
}

/** [{ name, version, where }] of a Cargo.lock. */
export function cargoLockVersions(text) {
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version) out.push({ name, version, where: `${name} ${version}` });
  }
  return out;
}

/** [{ name, version, where }] of a package.json: the floor of each declared range. */
export function manifestVersions(pkg) {
  const out = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const floor = rangeFloor(spec);
      if (floor) out.push({ name, version: floor, where: `${field}.${name} "${spec}"` });
    }
  }
  return out;
}

/** The versions in `file` (relative to root), by its kind. */
export function readVersions(root, file) {
  const text = readFileSync(join(root, file), "utf8");
  if (file.endsWith("Cargo.lock")) return cargoLockVersions(text);
  if (file.endsWith("package-lock.json")) return npmLockVersions(JSON.parse(text));
  if (file.endsWith("package.json")) return manifestVersions(JSON.parse(text));
  throw new Error(`${file}: not a package-lock.json, Cargo.lock or package.json`);
}

/**
 * Check the entries. `versionsOf(file)` returns the file's versions, or null
 * when the file doesn't exist.
 * @returns {{ errors: string[], open: string[] }}
 */
export function check(entries, versionsOf, today) {
  const errors = [];
  const open = [];
  const latest = new Date(Date.parse(today) + MAX_OPEN_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const e of entries) {
    const label = `${e.file}: ${e.name}`;
    const hasRange = typeof e.range === "string" && e.range.trim() !== "";
    const hasList = Array.isArray(e.versions) && e.versions.length > 0;
    if (!e.file || !e.name || hasRange === hasList || !Array.isArray(e.advisories) || e.advisories.length === 0 || !["fixed", "open"].includes(e.status)) {
      errors.push(`known-bad.json: entry ${JSON.stringify(e)} needs file, name, exactly one of range / versions, advisories and status "fixed" or "open"`);
      continue;
    }
    if (e.status === "open") {
      if (!e.fix || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? "") || Number.isNaN(Date.parse(e.expires))) {
        errors.push(`known-bad.json: open entry ${label} needs fix (the owner step) and expires (YYYY-MM-DD)`);
        continue;
      }
      if (e.expires > latest) {
        errors.push(`known-bad.json: open entry ${label} expires on ${e.expires}, more than ${MAX_OPEN_DAYS} days out (latest allowed: ${latest})`);
        continue;
      }
    }
    const versions = versionsOf(e.file);
    if (versions === null) {
      errors.push(`known-bad.json: ${e.file} does not exist (entry ${e.name})`);
      continue;
    }
    let isBad;
    try {
      isBad = hasRange ? (v) => inRange(v, e.range) : (v) => e.versions.includes(v);
      const hits = versions.filter((p) => p.name === e.name && parseVersion(p.version) && isBad(p.version));
      const what = `${e.severity ?? "?"} ${e.advisories.join(", ")}`;
      const at = hits.map((h) => `${h.version} (${h.where})`).join("; ");
      if (e.status === "fixed" && hits.length > 0) {
        errors.push(`${label} is back at a known-bad version: ${at} [${what}]`);
      } else if (e.status === "open" && hits.length === 0) {
        errors.push(`${label}: the open entry no longer matches anything; the bad version is gone, so set its status to "fixed"`);
      } else if (e.status === "open" && e.expires < today) {
        errors.push(`${label} is still at ${at} and its exception expired on ${e.expires} [${what}]; run: ${e.fix}`);
      } else if (e.status === "open") {
        open.push(`${label} ${at} [${what}] until ${e.expires}; owner: ${e.fix}`);
      }
    } catch (err) {
      errors.push(`known-bad.json: entry ${label}: ${err.message}`);
    }
  }
  return { errors, open };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { entries } = JSON.parse(readFileSync(join(root, "security/known-bad.json"), "utf8"));
  const cache = new Map();
  const versionsOf = (file) => {
    if (!cache.has(file)) cache.set(file, existsSync(join(root, file)) ? readVersions(root, file) : null);
    return cache.get(file);
  };
  const today = new Date().toISOString().slice(0, 10);
  const { errors, open } = check(entries, versionsOf, today);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ errors, open }, null, 2));
  } else {
    for (const o of open) console.warn(`audit-lock: open: ${o}`);
    for (const e of errors) console.error(`audit-lock: ${e}`);
    const fixed = entries.filter((e) => e.status === "fixed").length;
    console.log(`audit-lock: ${entries.length} entries (${fixed} fixed, ${open.length} open), ${errors.length} error(s)`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
