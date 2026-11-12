/**
 * One-command release (plan W4.5): the pure parts of
 * `npm run release -- <version> --dry-run | --publish` (scripts/release-run.mjs),
 * shared with its tests. No git, no network, no child processes here: the
 * caller reads the repository and passes text in.
 *
 *   - the updater placeholder in src-tauri/tauri.conf.json and its check
 *   - Tauri updater keys and .sig files (minisign inside base64), verified offline
 *   - the changelog from merged pull requests
 *   - bilingual release notes (Hebrew first, then English)
 *   - a byte-reproducible .tgz of the web build
 *   - the macOS update bundle's name, latest.json merging, the publish plan
 */
import { gzipSync } from "node:zlib";
import { compareVersions, isBeta, parseVersion, tagOf } from "./release.mjs";
import { formatPublicKey, parsePublicKey, rawPublicKey, readSecretKey, signData, verifyData } from "../supply-chain/minisign.mjs";

/** What the committed tauri.conf.json carries until a release fills it. */
export const PUBKEY_PLACEHOLDER = "${LUMEN_UPDATER_PUBKEY}";

/** The update endpoints on GitHub Releases: stable reads "latest" (never a pre-release), beta its rolling channel. */
export function updaterEndpoints(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error(`not a GitHub owner/repo: ${repo}`);
  return {
    stable: `https://github.com/${repo}/releases/latest/download/latest.json`,
    beta: `https://github.com/${repo}/releases/download/beta-channel/latest.json`,
  };
}

/**
 * A Tauri updater public key as tauri.conf.json takes it: the base64 of a
 * minisign public-key file (what `tauri signer generate` writes to *.key.pub).
 * Accepts that, or the minisign file's text itself. Returns the base64 form;
 * throws when it is empty, still the placeholder, or not a key.
 */
export function normalizeUpdaterPubkey(value) {
  const v = String(value ?? "").trim();
  if (!v) throw new Error("the updater public key is empty");
  if (v === PUBKEY_PLACEHOLDER || v.includes("${")) throw new Error("the updater public key is still the placeholder");
  let text = v;
  if (!v.startsWith("untrusted comment:")) {
    text = Buffer.from(v, "base64").toString("utf8");
    if (!text.startsWith("untrusted comment:")) throw new Error("the updater public key is not a minisign key (expected the base64 text of `tauri signer generate`'s .key.pub)");
  }
  parsePublicKey(text); // throws on a malformed key
  return v.startsWith("untrusted comment:") ? Buffer.from(text.endsWith("\n") ? text : `${text}\n`).toString("base64") : v;
}

/**
 * Check the updater block of a tauri.conf.json. `release: true` is the gate a
 * release build passes: a real key and https GitHub Releases endpoints.
 * Returns a list of problems (empty = OK).
 */
export function checkUpdaterConf(conf, { release = false } = {}) {
  const u = conf?.plugins?.updater;
  const problems = [];
  if (!u) return ["tauri.conf.json has no plugins.updater"];
  if (!Array.isArray(u.endpoints) || !u.endpoints.length) problems.push("plugins.updater.endpoints is empty");
  for (const e of u.endpoints ?? []) if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/(latest\/download|download\/[\w.-]+)\/latest\.json$/.test(e)) problems.push(`endpoint is not a GitHub Releases latest.json over https: ${e}`);
  if (release) {
    try {
      normalizeUpdaterPubkey(u.pubkey);
    } catch (e) {
      problems.push(e.message);
    }
    if (conf.bundle?.createUpdaterArtifacts !== true) problems.push("bundle.createUpdaterArtifacts is not true (no signed update bundles)");
  } else if (u.pubkey !== PUBKEY_PLACEHOLDER) problems.push(`the committed plugins.updater.pubkey must be the placeholder ${PUBKEY_PLACEHOLDER} (the release fills it)`);
  return problems;
}

/** tauri.conf.json filled for a release build: the key, the channel's endpoint, signed update bundles. */
export function fillUpdater(conf, { pubkey, repo, channel }) {
  const out = structuredClone(conf);
  const ends = updaterEndpoints(repo);
  out.plugins ??= {};
  out.plugins.updater = { ...(out.plugins.updater ?? {}), pubkey: normalizeUpdaterPubkey(pubkey), endpoints: [channel === "beta" ? ends.beta : ends.stable] };
  out.bundle ??= {};
  out.bundle.createUpdaterArtifacts = true;
  const problems = checkUpdaterConf(out, { release: true });
  if (problems.length) throw new Error(problems.join("; "));
  return out;
}

/** The environment the Rust shell is compiled with (src-tauri/src/updates.rs reads these with option_env!). */
export function updaterBuildEnv({ pubkey, repo }) {
  const ends = updaterEndpoints(repo);
  return { LUMEN_UPDATER_PUBKEY: normalizeUpdaterPubkey(pubkey), LUMEN_UPDATER_ENDPOINT: ends.stable, LUMEN_UPDATER_ENDPOINT_BETA: ends.beta };
}

/** A throwaway key pair in Tauri's formats, for dry runs and tests only — never for a publish. */
export function testUpdaterKey(generate) {
  const { pem, publicKey } = generate();
  return { pem, pubkey: Buffer.from(publicKey.replace("minisign public key", "minisign public key TEST")).toString("base64") };
}

/** Is this the throwaway test key? (`--publish` refuses one.) */
export const isTestKey = (pubkeyB64) => {
  try {
    return Buffer.from(String(pubkeyB64), "base64").toString("utf8").includes("minisign public key TEST");
  } catch {
    return false;
  }
};

/** A Tauri updater .sig for `data` (base64 of the minisign signature text), as `tauri signer sign` makes. */
export function tauriSign(data, pem, fileName, { passphrase, timestamp = 0 } = {}) {
  const minisig = signData(data, pem, { passphrase, untrusted: "signature from tauri secret key", trusted: `timestamp:${timestamp}\tfile:${fileName}` });
  return Buffer.from(minisig).toString("base64");
}

/** Verify a Tauri .sig (base64) for `data` against the updater public key (base64), as tauri-plugin-updater does. Throws on failure. */
export function verifyTauriSig(data, sigB64, pubkeyB64) {
  const minisig = Buffer.from(String(sigB64).trim(), "base64").toString("utf8");
  const pubText = Buffer.from(normalizeUpdaterPubkey(pubkeyB64), "base64").toString("utf8");
  return verifyData(data, minisig, pubText);
}

/** The public key (base64, Tauri form) of a PEM secret key. */
export function pubkeyOfPem(pem, passphrase) {
  return Buffer.from(formatPublicKey(rawPublicKey(readSecretKey(pem, passphrase)))).toString("base64");
}

/**
 * tauri build names the macOS update bundle `<Product>.app.tar.gz` with no
 * version or architecture, so two Macs (or two releases) would collide and
 * latest.json could not tell aarch64 from x86_64. Give it both.
 */
export function macUpdateName(name, version, arch) {
  const m = /^(.+)\.app\.tar\.gz(\.sig)?$/.exec(name);
  if (!m || m[1].includes(`_${version}_`)) return name;
  const a = arch === "arm64" || arch === "aarch64" ? "aarch64" : arch === "x64" || arch === "x86_64" ? "x64" : arch;
  return `${m[1]}_${version}_${a}.app.tar.gz${m[2] ?? ""}`;
}

/** Bundles of this version only (target/ keeps old ones). */
export function isBundleOf(name, version) {
  return name.includes(`_${version}_`) || /^[^_]+\.app\.tar\.gz(\.sig)?$/.test(name);
}

/** latest.json from two machines (macOS here, Linux there): platforms merged, the same version required. */
export function mergeLatest(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.version !== b.version) throw new Error(`latest.json versions differ: ${a.version} vs ${b.version}`);
  return { ...a, pub_date: a.pub_date > b.pub_date ? a.pub_date : b.pub_date, platforms: { ...a.platforms, ...b.platforms } };
}

/**
 * Check every platform of a latest.json against the bundles on disk and the
 * updater key: the signature must verify the file the URL names. Returns
 * problems (empty = OK). `files` maps file name → bytes.
 */
export function checkLatest(latest, files, pubkeyB64) {
  const problems = [];
  const platforms = Object.entries(latest?.platforms ?? {});
  if (!platforms.length) problems.push("latest.json has no platforms");
  for (const [p, { url, signature }] of platforms) {
    const name = decodeURIComponent(String(url).split("/").pop() ?? "");
    const data = files.get(name);
    if (!data) {
      problems.push(`${p}: ${name} is not in the release`);
      continue;
    }
    try {
      verifyTauriSig(data, signature, pubkeyB64);
    } catch (e) {
      problems.push(`${p}: ${name}: ${e.message}`);
    }
  }
  return problems;
}

/* ---------- changelog from merged pull requests ---------- */

/**
 * Merged pull requests in a `git log --format=%H%x1f%s%x1f%b%x1e` text, oldest
 * first, one per number. Understands GitHub's merge commit ("Merge pull
 * request #12 from owner/branch" + the title as body), a squash merge
 * ("title (#12)") and the merge-train form ("Merge #12 branch").
 */
export function mergedPrs(log) {
  const seen = new Map();
  const records = String(log)
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim());
  for (const r of records.reverse()) {
    const [hash = "", subject = "", body = ""] = r.split("\x1f");
    const s = subject.replace(/\s*\[skip ci\]\s*/gi, " ").trim();
    let m;
    let pr = null;
    if ((m = /^Merge pull request #(\d+) from (\S+)/.exec(s))) pr = { number: +m[1], branch: m[2].replace(/^[^/]+\//, ""), title: body.split("\n").map((l) => l.trim()).find(Boolean) ?? null };
    else if ((m = /^Merge #(\d+) (\S+)/.exec(s))) pr = { number: +m[1], branch: m[2], title: null };
    else if ((m = /^(.+?) \(#(\d+)\)$/.exec(s))) pr = { number: +m[2], branch: null, title: m[1] };
    if (pr && !seen.has(pr.number)) seen.set(pr.number, { ...pr, hash: hash.trim() });
  }
  return [...seen.values()];
}

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/;

/** A PR as a changelog entry: its title's Conventional Commit type, or "other". `titles` (number → title, from the GitHub API) wins. */
export function prEntry(pr, titles = new Map()) {
  const title = (titles.get(pr.number) ?? pr.title ?? pr.branch ?? `#${pr.number}`).replace(/\s*\[skip ci\]\s*/gi, " ").trim();
  const m = HEADER.exec(title);
  return m ? { number: pr.number, type: m[1].toLowerCase(), scope: m[2] ?? null, breaking: !!m[3], subject: m[4] } : { number: pr.number, type: "other", scope: null, breaking: false, subject: title };
}

const PR_SECTIONS = [
  ["breaking", "⚠ Breaking changes"],
  ["feat", "Added"],
  ["fix", "Fixed"],
  ["perf", "Performance"],
  ["revert", "Reverted"],
  ["docs", "Documentation"],
  ["other", "Other changes"],
];

/** The CHANGELOG.md section of a release, one line per merged PR, linked. */
export function prChangelogSection(version, entries, { date = new Date(), repo = null } = {}) {
  const line = (e) => `- ${e.scope ? `**${e.scope}:** ` : ""}${e.subject}${repo ? ` ([#${e.number}](https://github.com/${repo}/pull/${e.number}))` : ` (#${e.number})`}`;
  const bucket = (e) => (e.breaking ? "breaking" : ["feat", "fix", "perf", "revert", "docs"].includes(e.type) ? e.type : "other");
  const out = [`## [${version}] - ${date.toISOString().slice(0, 10)}`];
  for (const [key, title] of PR_SECTIONS) {
    const list = entries.filter((e) => bucket(e) === key);
    if (list.length) out.push("", `### ${title}`, "", ...list.map(line));
  }
  if (!entries.length) out.push("", "- No merged pull requests since the last release.");
  return out.join("\n") + "\n";
}

/* ---------- release notes ---------- */

/** The hand-written highlights files of a version (release-notes/<version>.<lang>.md). */
export const notesFiles = (version) => ({ he: `release-notes/${version}.he.md`, en: `release-notes/${version}.en.md` });

/**
 * The GitHub release body: Hebrew first (the product is Hebrew-first), then
 * English, then the full change list and how to verify the download.
 */
export function bilingualNotes({ version, he, en, changelog, repo }) {
  if (!he?.trim() || !en?.trim()) throw new Error(`release notes for ${version} need both ${notesFiles(version).he} and ${notesFiles(version).en}`);
  const tag = tagOf(version);
  const beta = isBeta(version);
  const verify = [
    "```bash",
    `gh release download ${tag} --repo ${repo} --dir lumen-${version}`,
    `cd lumen-${version}`,
    "minisign -Vm SHA256SUMS -p release-key.pub   # release-key.pub: security/release-key.pub in the repository",
    "sha256sum -c SHA256SUMS",
    "```",
  ].join("\n");
  return [
    `<div dir="rtl" lang="he">`,
    "",
    `## Lumen ${version}${beta ? " — גרסת בטא" : ""}`,
    "",
    he.trim(),
    "",
    "**אימות ההורדה:** הקובץ SHA256SUMS חתום ב-minisign. הפקודות למטה בודקות את החתימה ואז כל קובץ.",
    "",
    "</div>",
    "",
    verify,
    "",
    `## Lumen ${version}${beta ? " (beta)" : ""}`,
    "",
    en.trim(),
    "",
    "**Verify the download:** SHA256SUMS is signed with minisign; the commands above check the signature, then every file. The SBOM (CycloneDX) is `sbom.cdx.json`, signed the same way.",
    "",
    "<details><summary>All changes / כל השינויים</summary>",
    "",
    String(changelog ?? "").replace(/^## [^\n]*\n+/, "").trim(),
    "",
    "</details>",
    "",
  ].join("\n");
}

/** latest.json's "notes": short, both languages (the update dialog shows it). */
export function shortNotes({ version, he, en }) {
  const first = (t) => String(t ?? "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#")) ?? "";
  return `${first(he)}\n\n${first(en)}`.trim() || `Lumen ${version}`;
}

/* ---------- a reproducible .tgz ---------- */

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for a tar header: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const put = (s, off, len) => h.write(s, off, len, "utf8");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  h.fill(" ", 148, 156);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/**
 * A gzipped tar of `entries` ({ path, data }) that is the same bytes on every
 * machine: sorted paths, mode 0644, owner 0, mtime SOURCE_DATE_EPOCH, gzip
 * header without a time or OS. (`tar -czf` differs by OS and by clock.)
 */
export function reproducibleTgz(entries, mtime) {
  const parts = [];
  for (const { path, data } of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    parts.push(tarHeader(path, data.length, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  gz.writeUInt32LE(0, 4); // MTIME
  gz[9] = 255; // OS: unknown
  return gz;
}

/* ---------- arguments, preflight, plan ---------- */

/** `npm run release -- <version> --dry-run | --publish [options]`. */
export function parseRunArgs(argv) {
  const [version, ...rest] = argv;
  parseVersion(version);
  const has = (f) => rest.includes(f);
  if (has("--dry-run") && has("--publish")) throw new Error("--dry-run and --publish together: pick one");
  if (has("--publish") && has("--fake-build")) throw new Error("--fake-build is for dry runs only: a fake bundle is never published");
  const known = new Set(["--dry-run", "--publish", "--fake-build", "--no-repro", "--no-desktop", "--skip-checks", "--offline"]);
  const unknown = rest.filter((a) => !known.has(a));
  if (unknown.length) throw new Error(`unknown option ${unknown.join(", ")}`);
  return {
    version: String(version).replace(/^v/, ""),
    publish: has("--publish"),
    dryRun: !has("--publish"),
    fakeBuild: has("--fake-build"),
    repro: !has("--no-repro"),
    desktop: !has("--no-desktop"),
    checks: !has("--skip-checks"),
    offline: has("--offline"),
  };
}

/**
 * What must be in place before a release, as { ok, what, fix, blocking }.
 * `facts` is gathered by the caller (files, env, tools) so this stays pure.
 * A dry run needs no key (it makes throwaway ones); a publish needs every one.
 */
export function preflight(o, f) {
  const items = [];
  const add = (ok, what, fix, blocking = true) => items.push({ ok: !!ok, what, fix, blocking: !ok && blocking });
  add(compareVersions(o.version, f.current) > 0, `${o.version} is newer than the current ${f.current}`, `pick a version above ${f.current}`);
  add(!f.tagExists, `tag ${tagOf(o.version)} does not exist yet`, `${tagOf(o.version)} was already released: pick the next version`);
  add(!!f.repo, "the origin remote is a GitHub repository", "git remote set-url origin https://github.com/<owner>/<repo>.git");
  if (!o.fakeBuild) add(f.nodeModules, "node_modules is installed", "npm ci");
  if (o.desktop && !o.fakeBuild) {
    add(f.cargo, "Rust (cargo) is installed", "install Rust: https://rustup.rs");
    add(f.tauriCli, "the Tauri CLI is installed (node_modules/.bin/tauri)", "npm ci");
  }
  const notes = notesFiles(o.version);
  add(f.notes.he && f.notes.en, `release notes in Hebrew and English (${notes.he}, ${notes.en})`, `write ${notes.he} and ${notes.en} (a few lines each: what is new, who it is for)`, o.publish);
  if (o.publish) {
    add(f.clean, "the working tree is clean", "commit or move your changes first (git status)");
    add(f.branch === "main", `releasing from main (now on ${f.branch})`, "git switch main && git pull --ff-only");
    add(f.gh, "the GitHub CLI is signed in (gh auth status)", "gh auth login");
    add(f.updaterKey, "TAURI_SIGNING_PRIVATE_KEY is set (the updater signing key)", "export TAURI_SIGNING_PRIVATE_KEY=\"$(cat ~/.tauri/lumen-updater.key)\" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… (made once: npx tauri signer generate -w ~/.tauri/lumen-updater.key)");
    add(f.updaterPub && !f.updaterPubIsTest, "the updater public key (LUMEN_UPDATER_PUBKEY or security/updater-key.pub) is a real key", "cp ~/.tauri/lumen-updater.key.pub security/updater-key.pub && git add security/updater-key.pub && git commit -m 'chore(release): the updater public key'");
    add(f.releaseKey, "the release signing key (LUMEN_RELEASE_KEY, plan W1.27) opens with LUMEN_RELEASE_PASSPHRASE", "export LUMEN_RELEASE_KEY=~/.lumen-release/lumen-release.key LUMEN_RELEASE_PASSPHRASE=… (made once: node scripts/supply-chain/keys.mjs)");
    add(f.releasePub, "security/release-key.pub is committed and matches LUMEN_RELEASE_KEY", "cp ~/.lumen-release/lumen-release.pub security/release-key.pub && git add security/release-key.pub && git commit -m 'chore(release): the release public key'");
  } else {
    add(f.updaterKey && f.updaterPub, "updater key (else this dry run signs with a throwaway test key)", "nothing to do for a dry run", false);
    add(f.releaseKey, "release key (else this dry run signs with a throwaway test key)", "nothing to do for a dry run", false);
  }
  return items;
}

/** The commands a publish runs after the build, in order (a dry run prints them). */
export function publishCommands({ version, repo, assets }) {
  const tag = tagOf(version);
  return [
    `git push origin HEAD ${tag}`,
    `gh release create ${tag} --repo ${repo} --title "Lumen ${version}" --notes-file release/RELEASE_NOTES.md --verify-tag${isBeta(version) ? " --prerelease --latest=false" : ""} ${assets.map((a) => `release/${a}`).join(" ")}`,
    `gh release upload beta-channel --repo ${repo} release/latest.json --clobber   # the desktop beta channel (plan 14.4): every beta, and a stable release newer than the last beta`,
  ];
}
