/**
 * The installed dependency tree against package-lock.json (W8.9).
 *
 * What a gate tests has to be what ships: the train's vitest, the e2e gate
 * and the build all run on node_modules, and Vercel's `npm ci` installs the
 * lockfile. When node_modules was installed some other way (an `npm install`
 * that moved a version, a copied tree, a cache), the tests ran on versions
 * the lockfile does not name. Review RR8-473-3 found exactly that: the
 * offline tree had micromark-extension-directive 4.0.0, the lockfile pins
 * 3.0.2, and 4.0.0 parses non-ASCII directive names that 3.0.2 does not.
 *
 * Pure functions here; scripts/lockfile-drift.mjs reads the files and runs
 * `npm ls --all --json --long`.
 */

/** The lockfile v2/v3 `packages` map without the root entry. */
export function lockedPackages(lock) {
  const out = new Map();
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key === "" || !key.includes("node_modules/")) continue; // the root, and workspace sources (their link entry is checked)
    out.set(key, entry ?? {});
  }
  return out;
}

/** "node_modules/a/node_modules/@s/b" → "@s/b". */
export function nameOf(key) {
  const i = key.lastIndexOf("node_modules/");
  return key.slice(i + "node_modules/".length);
}

/**
 * `npm ls --all --json --long` → Map(lockfile key → { version, extraneous }).
 * Every node carries its absolute path; a deduped node repeats a path, which
 * is the same install (npm prints the tree, so there are no cycles). Paths outside the project (a symlinked tree) keep
 * their absolute path, so they can never match a lockfile key.
 */
export function flattenNpmLs(tree, root) {
  const base = String(root).replace(/\/+$/, "") + "/";
  const out = new Map();
  const walk = (node) => {
    for (const dep of Object.values(node?.dependencies ?? {})) {
      // A missing dependency has no path: lockDrift reports it from the lockfile's side.
      if (!dep || typeof dep !== "object" || dep.missing || !dep.path) continue;
      const key = dep.path.startsWith(base) ? dep.path.slice(base.length) : dep.path;
      if (!out.has(key)) out.set(key, { version: dep.version ?? null, extraneous: Boolean(dep.extraneous) });
      walk(dep); // a deduped node may list its children only at one of its places: walk each
    }
  };
  walk(tree);
  return out;
}

/**
 * The difference between what is installed and what is locked.
 *   installed: Map(key → { version, extraneous? })   (flattenNpmLs, or a disk walk)
 *   options.omitDev: dev-only entries may be absent (an `npm ci --omit=dev` tree)
 * Returns [{ kind, key, name, locked, installed }], kind one of
 *   "version"     installed at the lockfile's path with another version
 *   "missing"     locked, not optional, not installed
 *   "extraneous"  installed where the lockfile has nothing
 */
export function lockDrift(lock, installed, { omitDev = false } = {}) {
  const locked = lockedPackages(lock);
  const drift = [];
  for (const [key, entry] of locked) {
    const got = installed.get(key);
    if (entry.link) continue; // a workspace link: its target's entry is the package
    if (!got) {
      if (entry.optional || (omitDev && (entry.dev || entry.devOptional))) continue; // another platform's binary, or an omitted dev tree
      drift.push({ kind: "missing", key, name: nameOf(key), locked: entry.version ?? null, installed: null });
      continue;
    }
    if (entry.version && got.version !== entry.version) drift.push({ kind: "version", key, name: nameOf(key), locked: entry.version, installed: got.version ?? null });
  }
  for (const [key, got] of installed) {
    if (locked.has(key)) continue;
    if (!key.includes("node_modules/")) continue; // the project itself, or a workspace source
    drift.push({ kind: "extraneous", key, name: nameOf(key), locked: null, installed: got.version ?? null });
  }
  return drift.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * package.json's dependency fields against the lockfile's root entry, as
 * sets (npm sorts the lockfile's keys, package.json keeps the author's
 * order). A mismatch means the lockfile was not regenerated after an edit,
 * and `npm ci` refuses it. Needs no node_modules, so it runs offline.
 */
export const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
export function manifestDrift(pkg, lock) {
  const root = lock?.packages?.[""] ?? {};
  const out = [];
  for (const field of DEP_FIELDS) {
    const want = pkg?.[field] ?? {};
    const have = root[field] ?? {};
    for (const name of new Set([...Object.keys(want), ...Object.keys(have)])) {
      if (want[name] !== have[name]) out.push({ field, name, packageJson: want[name] ?? null, lockfile: have[name] ?? null });
    }
  }
  return out;
}

/**
 * Another tree a tool resolves this project's imports from (the offline
 * shims fall back to one): its hoisted copies against the lockfile's hoisted
 * versions. A package the tree lacks is not drift (the tool then fails to
 * import it, loudly); one it holds at another version is, because a test run
 * through that tree tests code that does not ship.
 *   readVersion(name) → the tree's version of `name`, or null
 */
export function treeDrift(lock, readVersion) {
  const out = [];
  for (const [key, entry] of lockedPackages(lock)) {
    if (key.slice("node_modules/".length).includes("node_modules/") || !key.startsWith("node_modules/")) continue; // hoisted only
    const name = nameOf(key);
    const got = readVersion(name);
    if (got && entry.version && got !== entry.version) out.push({ kind: "version", key, name, locked: entry.version, installed: got });
  }
  return out;
}

/** One line per finding, for the build log. */
export function describeDrift(d) {
  if (d.kind === "missing") return `missing     ${d.key} (locked ${d.locked})`;
  if (d.kind === "extraneous") return `extraneous  ${d.key} (installed ${d.installed}, not in package-lock.json)`;
  if (d.field) return `manifest    ${d.field}.${d.name}: package.json ${d.packageJson ?? "—"}, lockfile ${d.lockfile ?? "—"}`;
  return `version     ${d.key}: installed ${d.installed}, locked ${d.locked}`;
}
