#!/usr/bin/env node
/**
 * The whole release in one command (plan W4.5) — see scripts/release-run.mjs:
 *
 *   npm run release -- 0.2.0-beta.1 --dry-run      build, sign and check everything; publish nothing
 *   npm run release -- 0.2.0-beta.1 --publish      the owner's: commit, tag, build, sign, push, GitHub release
 *
 * The steps below remain for running one part at a time.
 *
 * The release pipeline (plan 13.4), runnable on a developer machine — no
 * GitHub Actions needed. docs/archive/workflows/release.yml runs the same steps
 * on a tag push when Actions are on; every step here works without them.
 *
 *   node scripts/release.mjs plan [--beta]         next version + changelog preview (changes nothing)
 *   node scripts/release.mjs prepare [--beta] [--version X] [--commit] [--tag]
 *                                                  bump every manifest, write CHANGELOG.md
 *                                                  (--beta: the next x.y.z-beta.n; --commit: commit it; --tag: and tag vX)
 *   node scripts/release.mjs build [--desktop] [--skip-checks]
 *                                                  typecheck, tests, web build, budget, no source maps,
 *                                                  web .tgz, desktop bundles (with --desktop), SHA256SUMS,
 *                                                  SHA256SUMS.asc (when LUMEN_RELEASE_GPG_KEY is set),
 *                                                  latest.json (when the updater signed the bundles) → release/
 *                                                  A beta version builds the web app with VITE_LUMEN_CHANNEL=beta
 *                                                  (beta flags on, the Beta badge) — plan 14.4.
 *   node scripts/release.mjs publish [--draft]     GitHub release for the tag at HEAD, notes from CHANGELOG.md,
 *                                                  every file in release/ attached (gh CLI). A beta is a
 *                                                  pre-release (never "latest", so stable users never get it);
 *                                                  its latest.json — and a stable one's, when newer — also goes
 *                                                  to the rolling "beta-channel" release the beta updater reads.
 *   node scripts/release.mjs deploy-beta           the beta web app: a Vercel preview deployment of dist/,
 *                                                  aliased to $LUMEN_BETA_HOST when set (stable stays on --prod)
 *   node scripts/release.mjs verify [dir]          check SHA256SUMS (and its signature) in release/ or dir
 *   node scripts/release.mjs rollback <bad> [--to <good>]
 *                                                  take a bad release back: it stops being "latest" (desktop
 *                                                  updates and download links fall back), and the commands to
 *                                                  redeploy the web app from the good tag are printed
 *   node scripts/release.mjs notes <version>       the version's notes, from CHANGELOG.md
 *   node scripts/release.mjs packages [--dir release] [--version X] [--repo owner/name]
 *                                                  Homebrew cask, winget, Flathub and AUR manifests from
 *                                                  release/SHA256SUMS → release/packages/, checked offline
 *                                                  (plan W1.24). Nothing is submitted: that is the owner's.
 *
 * Signing keys are the owner's (plan 15.7) and all optional: without one,
 * that signature is skipped with a warning and the release still builds.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { bumpManifests, changelogSection, insertChangelog, nextVersion, parseCommits, releaseNotes, sha256sums, tagOf, verifySums, compareVersions, isBeta, nextBetaVersion } from "./lib/release.mjs";
import { LOCALES, UNTRANSLATED, addUntranslated } from "./lib/whats-new.mjs";
import { betaFlags } from "./lib/flags.mjs";
import { latestJson } from "./lib/tauriSigning.mjs";
import { allPackages, flatpakManifest, packagingMeta, parseSums, wingetObjects } from "./lib/packaging.mjs";
import { checkAur, checkCask, checkFlatpak, checkWinget } from "./lib/packagingCheck.mjs";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "release");
const MANIFESTS = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "ios/App/App.xcodeproj/project.pbxproj"];
const [cmd, ...args] = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (bin, a, extra = {}) => {
  console.log(`$ ${bin} ${a.join(" ")}`);
  const r = spawnSync(bin, a, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", ...extra });
  if (r.status !== 0) throw new Error(`${bin} ${a.join(" ")} failed (${r.status ?? r.signal})`);
};
const warn = (m) => console.warn(`warning: ${m}`);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const current = () => JSON.parse(read("package.json")).version;

function repoSlug() {
  try {
    const url = git("remote", "get-url", "origin");
    return /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The last release tag; `stable` skips betas, so a stable changelog covers the whole beta train. */
function lastTag({ stable = false } = {}) {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", ...(stable ? ["--exclude", "v*-*"] : []));
  } catch {
    return null;
  }
}

/** The rolling release whose latest.json the desktop beta channel reads (LUMEN_UPDATER_ENDPOINT_BETA). */
const BETA_CHANNEL_TAG = "beta-channel";

function commitsSince(tag) {
  const range = tag ? [`${tag}..HEAD`] : ["HEAD"];
  return parseCommits(git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", ...range));
}

function planned() {
  const beta = flag("--beta");
  const tag = lastTag({ stable: !beta });
  const commits = commitsSince(tag);
  const version = opt("--version") ?? (beta ? nextBetaVersion(current(), commits) : nextVersion(current(), commits));
  return { tag, commits, version };
}

function registry() {
  try {
    return JSON.parse(read("src/flags/flags.json"));
  } catch {
    return { flags: [] };
  }
}

function filesIn(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * Point the desktop beta channel at this release when it is newer than what
 * the channel has: a beta always, a stable release once it passes the last
 * beta. The channel is the rolling pre-release BETA_CHANNEL_TAG, whose
 * latest.json LUMEN_UPDATER_ENDPOINT_BETA names.
 */
function updateBetaChannel(version) {
  let have = null;
  const tmp = path.join(OUT, ".beta-channel");
  rmSync(tmp, { recursive: true, force: true });
  try {
    execFileSync("gh", ["release", "download", BETA_CHANNEL_TAG, "--pattern", "latest.json", "--dir", tmp], { cwd: ROOT, stdio: "ignore" });
    have = JSON.parse(readFileSync(path.join(tmp, "latest.json"), "utf8")).version ?? null;
  } catch {
    // No channel release yet: create it (a pre-release, so it is never "latest").
    try {
      execFileSync("gh", ["release", "view", BETA_CHANNEL_TAG], { cwd: ROOT, stdio: "ignore" });
    } catch {
      run("gh", ["release", "create", BETA_CHANNEL_TAG, "--prerelease", "--latest=false", "--title", "Beta channel", "--notes", "Rolling pointer for the desktop beta update channel (plan 14.4). Not a release: its latest.json names the newest beta or stable release."]);
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  if (have && compareVersions(version, have) <= 0) return console.log(`beta channel stays on ${have} (newer than ${version})`);
  run("gh", ["release", "upload", BETA_CHANNEL_TAG, path.join(OUT, "latest.json"), "--clobber"]);
  console.log(`beta channel → ${version}`);
}

const commands = {
  plan() {
    const { tag, commits, version } = planned();
    console.log(`current: ${current()} · last tag: ${tag ?? "(none)"} · commits since: ${commits.length}`);
    if (!version) return console.log("nothing to release (no feat, fix, perf or breaking change since the last tag)");
    console.log(`next: ${version} (${tagOf(version)})\n`);
    console.log(changelogSection(version, commits, { repo: repoSlug() }));
    const inBeta = betaFlags(registry());
    if (inBeta.length) console.log(`${isBeta(version) ? "On in this beta" : "Still beta only (off in this release)"}: ${inBeta.join(", ")}`);
  },

  prepare() {
    const { commits, version } = planned();
    if (!version) throw new Error("nothing to release: no feat, fix, perf or breaking change since the last tag (or pass --version)");
    if (flag("--commit") && git("status", "--porcelain")) throw new Error("the working tree has changes: commit or stash them first");
    const files = Object.fromEntries(MANIFESTS.filter((p) => existsSync(path.join(ROOT, p))).map((p) => [p, read(p)]));
    const changed = bumpManifests(files, version);
    for (const [p, text] of Object.entries(changed)) writeFileSync(path.join(ROOT, p), text);
    const changelog = existsSync(path.join(ROOT, "CHANGELOG.md")) ? read("CHANGELOG.md") : "";
    const section = changelogSection(version, commits, { repo: repoSlug() });
    writeFileSync(path.join(ROOT, "CHANGELOG.md"), insertChangelog(changelog, section));
    // Plan 14.6: the same section in each translation, marked untranslated until someone translates it.
    const translations = LOCALES.filter((l) => l !== "en").map((l) => `changelog/${l}.md`).filter((p) => existsSync(path.join(ROOT, p)));
    for (const p of translations) writeFileSync(path.join(ROOT, p), addUntranslated(read(p), section));
    console.log(`version ${version}: ${[...Object.keys(changed), "CHANGELOG.md", ...translations].join(", ")}`);
    if (translations.length) console.log(`translate the new section in ${translations.join(", ")} (remove the ${UNTRANSLATED} line) — "What's new" shows English until then`);
    if (flag("--commit")) {
      git("add", "CHANGELOG.md", ...translations, ...Object.keys(changed));
      git("commit", "-m", `chore(release): ${version}`);
      if (flag("--tag")) {
        git("tag", "-a", tagOf(version), "-m", `Lumen ${version}`);
        console.log(`tagged ${tagOf(version)} — push with: git push origin HEAD ${tagOf(version)}`);
      }
    } else console.log("review, then: git commit -am 'chore(release): " + version + "' && git tag -a " + tagOf(version) + " -m 'Lumen " + version + "'");
  },

  build() {
    const version = current();
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    if (!flag("--skip-checks")) {
      run("npm", ["run", "typecheck"]);
      run("npm", ["test"]);
    }
    // Plan 14.4: a beta builds as the beta channel (beta flags on, the Beta badge).
    const channelEnv = { env: { ...process.env, VITE_LUMEN_CHANNEL: isBeta(version) ? "beta" : "stable" } };
    run("npm", ["run", "flags:check"]);
    run("npm", ["run", "build"], channelEnv);
    run("npm", ["run", "budget"]);
    run("node", ["scripts/check-sourcemaps.mjs", "dist"]);
    run("tar", ["-czf", path.join(OUT, `lumen-web-${tagOf(version)}.tgz`), "-C", "dist", "."]);

    if (flag("--desktop")) {
      if (!process.env.TAURI_SIGNING_PRIVATE_KEY) warn("TAURI_SIGNING_PRIVATE_KEY not set — no signed update artifacts, auto-update stays off (plan 15.7)");
      if (process.platform === "darwin" && !process.env.APPLE_SIGNING_IDENTITY) warn("Apple signing not set — the macOS build is ad-hoc signed, not notarised (plan 15.7)");
      run("node", ["scripts/tauri-signing.mjs", "updater-config"]);
      // Windows MSI takes only numeric pre-release versions: a beta ships the NSIS installer alone.
      run("npm", ["run", "tauri:build", ...(isBeta(version) && process.platform === "win32" ? ["--", "--bundles", "nsis"] : [])], channelEnv);
      const bundles = filesIn(path.join(ROOT, "src-tauri", "target")).filter((f) => /[/\\]release[/\\]bundle[/\\]/.test(f) && /\.(dmg|msi|exe|deb|rpm|AppImage|tar\.gz|sig)$/i.test(f));
      for (const f of bundles) copyFileSync(f, path.join(OUT, path.basename(f)));
      const sigs = readdirSync(OUT).filter((n) => n.endsWith(".sig")).map((name) => ({ name, signature: readFileSync(path.join(OUT, name), "utf8") }));
      const repo = repoSlug();
      if (sigs.length && repo) {
        const manifest = latestJson({ tag: tagOf(version), repo, sigs, notes: releaseNotes(existsSync(path.join(ROOT, "CHANGELOG.md")) ? read("CHANGELOG.md") : "", version) ?? "" });
        writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
      } else if (!sigs.length) warn("no .sig files — no latest.json");
    }
    // Mobile (plan 13.3): the .ipa / .aab are built and signed in Xcode / Android Studio
    // (RELEASE.md §3–4); drop them into release/ before this step to include them in the sums.
    const entries = readdirSync(OUT)
      .filter((n) => n !== "SHA256SUMS" && n !== "SHA256SUMS.asc")
      .map((name) => ({ name, data: readFileSync(path.join(OUT, name)) }));
    writeFileSync(path.join(OUT, "SHA256SUMS"), sha256sums(entries));
    const key = process.env.LUMEN_RELEASE_GPG_KEY;
    if (key) run("gpg", ["--batch", "--yes", "--local-user", key, "--armor", "--detach-sign", "--output", path.join(OUT, "SHA256SUMS.asc"), path.join(OUT, "SHA256SUMS")]);
    else warn("LUMEN_RELEASE_GPG_KEY not set — SHA256SUMS is not signed (plan 15.7)");
    console.log(`release/: ${readdirSync(OUT).join(", ")}`);
  },

  publish() {
    const version = current();
    const tag = tagOf(version);
    const at = git("rev-list", "-n", "1", tag);
    if (at !== git("rev-parse", "HEAD")) throw new Error(`${tag} is not HEAD: check out the tag you are releasing`);
    if (!existsSync(path.join(OUT, "SHA256SUMS"))) throw new Error("release/ has no SHA256SUMS: run `node scripts/release.mjs build` first");
    const bad = verifySums(readFileSync(path.join(OUT, "SHA256SUMS"), "utf8"), readdirSync(OUT).filter((n) => !n.startsWith("SHA256SUMS")).map((name) => ({ name, data: readFileSync(path.join(OUT, name)) })));
    if (bad.length) throw new Error(`release/ does not match SHA256SUMS: ${bad.join(", ")}`);
    const notes = releaseNotes(read("CHANGELOG.md"), version) ?? `Lumen ${version}`;
    const notesFile = path.join(OUT, ".notes.md");
    writeFileSync(notesFile, notes);
    const assets = readdirSync(OUT).filter((n) => !n.startsWith(".")).map((n) => path.join(OUT, n));
    run("gh", ["release", "create", tag, "--title", `Lumen ${version}`, "--notes-file", notesFile, "--verify-tag", ...(flag("--draft") ? ["--draft"] : []), ...(/-/.test(version) ? ["--prerelease"] : []), ...assets]);
    rmSync(notesFile);
    if (!flag("--draft") && existsSync(path.join(OUT, "latest.json"))) updateBetaChannel(version);
  },

  "deploy-beta"() {
    // The beta web app (plan 14.4): a separate deployment from the same build pipeline, never production.
    if (!isBeta(current())) throw new Error(`${current()} is not a beta: run \`release.mjs prepare --beta\` first`);
    if (!existsSync(path.join(ROOT, "dist", "index.html"))) throw new Error("no dist/: run `node scripts/release.mjs build` first");
    const out = execFileSync("npx", ["vercel", "deploy", "dist", "--yes"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
    const url = out.split("\n").pop();
    console.log(`beta deployed: ${url}`);
    const host = (process.env.LUMEN_BETA_HOST ?? "").trim();
    if (host) run("npx", ["vercel", "alias", "set", url, host]);
    else warn("LUMEN_BETA_HOST not set — the beta is only at its deployment URL");
  },

  verify() {
    const dir = path.resolve(args[0] ?? OUT);
    const sums = readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
    const bad = verifySums(sums, readdirSync(dir).filter((n) => !n.startsWith("SHA256SUMS")).map((name) => ({ name, data: readFileSync(path.join(dir, name)) })));
    if (bad.length) throw new Error(`checksum mismatch: ${bad.join(", ")}`);
    if (existsSync(path.join(dir, "SHA256SUMS.asc"))) run("gpg", ["--verify", path.join(dir, "SHA256SUMS.asc"), path.join(dir, "SHA256SUMS")]);
    else warn("no SHA256SUMS.asc — checksums only, no signature");
    console.log("checksums OK");
  },

  rollback() {
    const bad = args[0];
    if (!bad || bad.startsWith("--")) throw new Error("usage: release.mjs rollback <bad-version> [--to <good-version>]");
    const badTag = tagOf(bad);
    const good = opt("--to");
    // A prerelease is never "latest": releases/latest (the desktop updater's latest.json, the
    // download links) falls back to the newest good release at once.
    run("gh", ["release", "edit", badTag, "--prerelease", "--latest=false"]);
    if (good) run("gh", ["release", "edit", tagOf(good), "--latest"]);
    console.log(`
${badTag} is no longer the latest release. New installs and update checks get ${good ? tagOf(good) : "the previous release"}.
Desktop apps already on ${bad} stay on it until a newer version ships (the updater never downgrades):
  git checkout ${good ? tagOf(good) : "<good tag>"} && git switch -c hotfix/${bad}   # fix or revert there
  node scripts/release.mjs prepare --version <next patch> --commit --tag
Web app: redeploy the good tag —
  git checkout ${good ? tagOf(good) : "<good tag>"} && npm ci && npm run build && npx vercel deploy --prod dist
  (or, on Vercel, promote the previous production deployment: npx vercel rollback)`);
  },

  packages() {
    const dir = path.resolve(ROOT, opt("--dir") ?? "release");
    const sumsFile = path.join(dir, "SHA256SUMS");
    if (!existsSync(sumsFile)) throw new Error(`${path.relative(ROOT, sumsFile)} is missing: run \`node scripts/release.mjs build --desktop\` first (every hash comes from it)`);
    const sums = parseSums(readFileSync(sumsFile, "utf8"));
    const meta = packagingMeta({
      pkg: JSON.parse(read("package.json")),
      tauri: JSON.parse(read("src-tauri/tauri.conf.json")),
      version: opt("--version") ?? current(),
      repo: opt("--repo") ?? repoSlug(),
      licenseSha256: createHash("sha256").update(readFileSync(path.join(ROOT, "LICENSE"))).digest("hex"),
    });
    const { files, report } = allPackages(meta, sums);
    const out = path.join(dir, "packages");
    rmSync(out, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      writeFileSync(path.join(out, rel), text);
    }
    const problems = [];
    const has = (f) => report.find((r) => r.format === f)?.status === "written";
    if (has("winget")) problems.push(...checkWinget(wingetObjects(meta, sums)));
    if (has("homebrew")) problems.push(...checkCask(files[`homebrew/${meta.caskName}.rb`]));
    if (has("flatpak")) problems.push(...checkFlatpak(flatpakManifest(meta, sums).manifest, files[`flatpak/${meta.flatpakId}.metainfo.xml`]));
    if (has("aur")) problems.push(...checkAur(files[`aur/${meta.aurName}/PKGBUILD`], files[`aur/${meta.aurName}/.SRCINFO`]));
    for (const r of report) console.log(`${r.format.padEnd(9)} ${r.status}: ${r.detail}`);
    if (problems.length) throw new Error(`the manifests do not pass the offline checks:\n  ${problems.join("\n  ")}`);
    console.log(`checked offline → ${path.relative(ROOT, out)}/ (submit them yourself: see RELEASE.md "Stores and package managers")`);
  },

  notes() {
    const v = args[0] ?? current();
    const n = releaseNotes(read("CHANGELOG.md"), v);
    if (!n) throw new Error(`CHANGELOG.md has no section for ${v}`);
    process.stdout.write(n);
  },
};

// Plan W4.5: `npm run release -- <version> --dry-run | --publish` runs the whole release (scripts/release-run.mjs).
if (/^v?\d+\.\d+\.\d+/.test(cmd ?? "")) {
  try {
    const { main } = await import("./release-run.mjs");
    await main([cmd, ...args]);
    process.exit(0);
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}
if (!commands[cmd]) {
  console.error("usage: node scripts/release.mjs <version> --dry-run | --publish  (the whole release, plan W4.5)\n       node scripts/release.mjs plan | prepare | build | publish | deploy-beta | verify | rollback <bad> | notes <version> | packages");
  process.exit(2);
}
try {
  commands[cmd]();
} catch (e) {
  console.error(`release: ${e.message}`);
  process.exit(1);
}
