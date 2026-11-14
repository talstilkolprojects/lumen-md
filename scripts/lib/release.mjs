/**
 * The release pipeline's pure parts (plan 13.4), shared by scripts/release.mjs
 * and its tests: the next version from Conventional Commits, the changelog
 * section, the version bump in every manifest, release notes, checksums.
 * No git, no network, no file system here.
 */
import { createHash } from "node:crypto";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v).replace(/^v/, ""));
  if (!m) throw new Error(`not a semver version: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

export function formatVersion({ major, minor, patch, pre }) {
  return `${major}.${minor}.${patch}${pre ? `-${pre}` : ""}`;
}

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/;

/**
 * Commits (`git log --format=%H%x1f%s%x1f%b%x1e`) → Conventional Commits.
 * Merge commits and lines that are not conventional are kept as `other`.
 */
export function parseCommits(log) {
  return String(log)
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [hash = "", subject = "", body = ""] = r.split("\x1f");
      const m = HEADER.exec(subject.trim());
      const clean = (s) => s.replace(/\s*\[skip ci\]\s*/gi, " ").trim();
      if (!m) return { hash: hash.trim(), type: "other", scope: null, breaking: /BREAKING[ -]CHANGE:/.test(body), subject: clean(subject) };
      return {
        hash: hash.trim(),
        type: m[1].toLowerCase(),
        scope: m[2] ?? null,
        breaking: !!m[3] || /BREAKING[ -]CHANGE:/.test(body),
        subject: clean(m[4]),
      };
    });
}

/**
 * The next version. Breaking → major (minor before 1.0), feat → minor,
 * fix / perf → patch; nothing releasable → null. A pre-release (`1.2.0-rc.1`)
 * is released as itself.
 */
export function nextVersion(current, commits) {
  const v = parseVersion(current);
  if (v.pre) return formatVersion({ ...v, pre: null });
  const breaking = commits.some((c) => c.breaking);
  const feat = commits.some((c) => c.type === "feat");
  const fix = commits.some((c) => c.type === "fix" || c.type === "perf");
  if (breaking) return v.major === 0 ? formatVersion({ major: 0, minor: v.minor + 1, patch: 0 }) : formatVersion({ major: v.major + 1, minor: 0, patch: 0 });
  if (feat) return formatVersion({ ...v, minor: v.minor + 1, patch: 0, pre: null });
  if (fix) return formatVersion({ ...v, patch: v.patch + 1, pre: null });
  return null;
}

const SECTIONS = [
  ["breaking", "⚠ Breaking changes"],
  ["feat", "Added"],
  ["fix", "Fixed"],
  ["perf", "Performance"],
  ["revert", "Reverted"],
  ["docs", "Documentation"],
];

/** The changelog section for a version (Keep a Changelog headings). */
export function changelogSection(version, commits, { date = new Date(), repo = null } = {}) {
  const day = date.toISOString().slice(0, 10);
  const line = (c) => {
    const ref = repo && c.hash ? ` ([${c.hash.slice(0, 7)}](https://github.com/${repo}/commit/${c.hash}))` : "";
    return `- ${c.scope ? `**${c.scope}:** ` : ""}${c.subject}${ref}`;
  };
  const out = [`## [${version}] - ${day}`];
  for (const [key, title] of SECTIONS) {
    const list = key === "breaking" ? commits.filter((c) => c.breaking) : commits.filter((c) => c.type === key && !c.breaking);
    if (!list.length) continue;
    out.push("", `### ${title}`, "", ...list.map(line));
  }
  return out.join("\n") + "\n";
}

/** CHANGELOG.md with the new section right under `## [Unreleased]` (or under the intro). */
export function insertChangelog(changelog, section) {
  const text = changelog || "# Changelog\n";
  const at = text.search(/^## \[Unreleased\][^\n]*\n/m);
  if (at >= 0) {
    // After the Unreleased block (its notes stay where they are), before the first released version.
    const next = text.slice(at + 1).search(/^## \[/m);
    if (next >= 0) {
      const i = at + 1 + next;
      return `${text.slice(0, i)}${section}\n${text.slice(i)}`;
    }
    return `${text.trimEnd()}\n\n${section}`;
  }
  const first = text.search(/^## /m);
  if (first >= 0) return `${text.slice(0, first)}${section}\n${text.slice(first)}`;
  return `${text.trimEnd()}\n\n${section}`;
}

/** The notes of one version, from the changelog (for the GitHub release). */
export function releaseNotes(changelog, version) {
  const v = String(version).replace(/^v/, "");
  const start = changelog.search(new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\]`, "m"));
  if (start < 0) return null;
  const rest = changelog.slice(start);
  const end = rest.slice(1).search(/^## \[/m);
  return (end < 0 ? rest : rest.slice(0, end + 1)).replace(/^## [^\n]*\n+/, "").trim() + "\n";
}

/**
 * Every manifest that carries the version, bumped in lock-step:
 * package.json, package-lock.json (root + packages[""]), tauri.conf.json,
 * Cargo.toml ([package]), and the iOS project (MARKETING_VERSION, and
 * CURRENT_PROJECT_VERSION + 1 for the store's build number).
 * `files` maps path → text; returns the changed ones.
 */
export function bumpManifests(files, version) {
  parseVersion(version);
  const out = {};
  const json = (path, edit) => {
    if (files[path] === undefined) return;
    const data = JSON.parse(files[path]);
    edit(data);
    const indent = /^\{\n( +|\t)/.exec(files[path])?.[1] ?? "  ";
    out[path] = JSON.stringify(data, null, indent) + (files[path].endsWith("\n") ? "\n" : "");
  };
  json("package.json", (d) => (d.version = version));
  json("package-lock.json", (d) => {
    d.version = version;
    if (d.packages?.[""]) d.packages[""].version = version;
  });
  json("src-tauri/tauri.conf.json", (d) => (d.version = version));
  const cargo = files["src-tauri/Cargo.toml"];
  if (cargo !== undefined) {
    const i = cargo.indexOf("[package]");
    if (i < 0) throw new Error("Cargo.toml has no [package]");
    const end = cargo.slice(i + 1).search(/^\[/m);
    const head = end < 0 ? cargo.slice(i) : cargo.slice(i, i + 1 + end);
    if (!/^version = "[^"]*"/m.test(head)) throw new Error("Cargo.toml [package] has no version");
    out["src-tauri/Cargo.toml"] = cargo.slice(0, i) + head.replace(/^version = "[^"]*"/m, `version = "${version}"`) + (end < 0 ? "" : cargo.slice(i + 1 + end));
  }
  const pbx = "ios/App/App.xcodeproj/project.pbxproj";
  if (files[pbx] !== undefined) {
    out[pbx] = files[pbx]
      .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version.replace(/-.*/, "")};`)
      .replace(/CURRENT_PROJECT_VERSION = (\d+);/g, (_m, n) => `CURRENT_PROJECT_VERSION = ${Number(n) + 1};`);
  }
  return out;
}

/** `sha256  name` lines, sorted by name (the format `sha256sum -c` reads). */
export function sha256sums(entries) {
  return (
    entries
      .map(({ name, data }) => ({ name, hash: createHash("sha256").update(data).digest("hex") }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(({ name, hash }) => `${hash}  ${name}`)
      .join("\n") + "\n"
  );
}

/** Check a SHA256SUMS text against files; returns the names that don't match (or are missing). */
export function verifySums(sums, entries) {
  const have = new Map(entries.map(({ name, data }) => [name, createHash("sha256").update(data).digest("hex")]));
  const bad = [];
  for (const line of sums.split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!m || have.get(m[2]) !== m[1]) bad.push(m ? m[2] : line);
  }
  return bad;
}

/** The tag for a version. */
export const tagOf = (version) => `v${String(version).replace(/^v/, "")}`;

/**
 * Semver order (plan 14.4): -1, 0 or 1. A pre-release sorts before its
 * release (1.2.0-beta.3 < 1.2.0), and pre-release fields compare as
 * numbers when both are numeric, else as text.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const p = x.pre.split(".");
  const q = y.pre.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]);
    if (p[i] === q[i]) continue;
    if (n) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The next beta (plan 14.4). From a stable version: the release the
 * commits call for, as its beta.1 (0.1.0 + a feat → 0.2.0-beta.1). From a
 * beta: the next beta of the same release (0.2.0-beta.1 → 0.2.0-beta.2);
 * to aim a beta train at another version, pass --version. Null when there
 * is nothing to release.
 */
export function nextBetaVersion(current, commits) {
  const v = parseVersion(current);
  const beta = v.pre && /^beta\.(\d+)$/.exec(v.pre);
  if (beta) return commits.length ? `${formatVersion({ ...v, pre: null })}-beta.${Number(beta[1]) + 1}` : null;
  const target = nextVersion(formatVersion({ ...v, pre: null }), commits);
  return target ? `${target}-beta.1` : null;
}

/** Is this version on the beta channel? */
export const isBeta = (version) => /-beta\.\d+$/.test(String(version));
