#!/usr/bin/env node
/**
 * The whole release in one command (plan W4.5), no GitHub Actions:
 *
 *   npm run release -- 0.2.0-beta.1 --dry-run     everything, nothing published, the tree left as it was
 *   npm run release -- 0.2.0-beta.1 --publish     the owner's: commit + tag, build, sign, push, GitHub release
 *
 * Options: --fake-build (dry run without node_modules / Rust: stand-in bundles),
 * --no-repro (one web build instead of two), --no-desktop, --skip-checks
 * (no typecheck / tests), --offline (PR titles from git only).
 *
 * Steps, in order:
 *   1. preflight: every missing key, tool or file, each with the command that fixes it
 *   2. version bump in every manifest + CHANGELOG.md from the merged pull requests
 *      (+ changelog/<lang>.md marked untranslated, plan 14.6)
 *   3. --publish: commit "chore(release): X" and tag vX
 *   4. src-tauri/tauri.conf.json: the updater placeholder filled (key, GitHub Releases endpoint,
 *      signed update bundles) — and put back afterwards; the committed file keeps the placeholder
 *   5. web build twice with SOURCE_DATE_EPOCH, compared file by file (repro-check), budget, no maps,
 *      lumen-web-vX.tgz byte-reproducible
 *   6. desktop: tauri build with TAURI_SIGNING_PRIVATE_KEY → bundles + .sig; latest.json; every
 *      signature checked against the updater key, and a changed byte must fail the check
 *   7. sbom.cdx.json (CycloneDX, offline from package-lock.json + Cargo.lock)
 *   8. RELEASE_NOTES.md: Hebrew, then English (release-notes/<version>.{he,en}.md), then every change
 *   9. SHA256SUMS of every asset, SHA256SUMS.minisig + sbom.cdx.json.minisig (plan W1.27's key), verified
 *  9b. W7.22: SLSA provenance + a keyless Sigstore bundle per file, checked by verify.mjs (scripts/supply-chain/release-gate.mjs);
 *      a dry run uses TEST keys and the local Sigstore stand-in, --publish the real ones (nothing is pushed unless it passes)
 *  10. --publish: git push, gh release create (a beta is a pre-release), the beta channel's latest.json
 *
 * A dry run without the owner's keys signs with throwaway test keys (made in a temp folder, named TEST
 * inside the key), so the signing and verification paths still run end to end.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bumpManifests, compareVersions, insertChangelog, isBeta, sha256sums, tagOf, verifySums } from "./lib/release.mjs";
import { LOCALES, addUntranslated } from "./lib/whats-new.mjs";
import { latestJson } from "./lib/tauriSigning.mjs";
import {
  bilingualNotes,
  checkLatest,
  fillUpdater,
  isBundleOf,
  isTestKey,
  macUpdateName,
  mergeLatest,
  mergedPrs,
  normalizeUpdaterPubkey,
  notesFiles,
  parseRunArgs,
  preflight,
  prChangelogSection,
  prEntry,
  publishCommands,
  reproducibleTgz,
  shortNotes,
  testUpdaterKey,
  updaterBuildEnv,
  verifyTauriSig,
} from "./lib/releaseRun.mjs";
import { fakeDesktop } from "./lib/releaseFake.mjs";
import { filesUnder } from "./supply-chain/lib.mjs";
import { formatPublicKey, generateKeys, parsePublicKey, rawPublicKey, readSecretKey, signData, verifyData } from "./supply-chain/minisign.mjs";
import { buildSbom, sourceDate } from "./supply-chain/sbom.mjs";
import { verifyRelease } from "./supply-chain/verify-release.mjs";
import { provenanceGate } from "./supply-chain/release-gate.mjs";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "release");
const CONF = "src-tauri/tauri.conf.json";
const MANIFESTS = ["package.json", "package-lock.json", CONF, "src-tauri/Cargo.toml", "ios/App/App.xcodeproj/project.pbxproj"];

const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => existsSync(path.join(ROOT, p));
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();
const tryRun = (bin, a) => spawnSync(bin, a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }).status === 0;
const step = (n, m) => console.log(`\n== ${n}. ${m}`);
const warn = (m) => console.warn(`warning: ${m}`);
function run(bin, a, env = {}) {
  console.log(`$ ${bin} ${a.join(" ")}`);
  const r = spawnSync(bin, a, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${bin} ${a.join(" ")} failed (${r.status ?? r.signal})`);
}

function repoSlug() {
  try {
    return /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"))?.[1] ?? null;
  } catch {
    return null;
  }
}

function lastTag(stable) {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", ...(stable ? ["--exclude", "v*-*"] : []));
  } catch {
    return null;
  }
}

/** PR number → title from the GitHub API (one call per 100 PRs, explicit pages); empty when offline. */
function prTitles(repo, offline) {
  const titles = new Map();
  if (offline || !repo) return titles;
  try {
    for (let page = 1; page <= 50; page++) {
      const tsv = execFileSync("gh", ["api", `repos/${repo}/pulls?state=all&per_page=100&page=${page}`, "--jq", ".[]|[.number,.title]|@tsv"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, maxBuffer: 1 << 26 });
      const lines = tsv.split("\n").filter(Boolean);
      for (const l of lines) titles.set(Number(l.split("\t")[0]), l.split("\t").slice(1).join("\t"));
      if (lines.length < 100) break;
    }
  } catch {
    warn("could not read PR titles from GitHub (gh offline or signed out?): the changelog uses the branch names");
  }
  return titles;
}

function envUpdaterPub() {
  const v = (process.env.LUMEN_UPDATER_PUBKEY ?? "").trim() || (exists("security/updater-key.pub") ? read("security/updater-key.pub").trim() : "");
  try {
    return v ? normalizeUpdaterPubkey(v) : null;
  } catch {
    return null;
  }
}

function envReleaseKey() {
  const p = process.env.LUMEN_RELEASE_KEY;
  if (!p || !existsSync(p)) return null;
  const pem = readFileSync(p, "utf8");
  const passphrase = process.env.LUMEN_RELEASE_PASSPHRASE || undefined;
  try {
    readSecretKey(pem, passphrase);
    return { pem, passphrase };
  } catch {
    return null;
  }
}

function facts(o, repo) {
  const tag = tagOf(o.version);
  let tagExists = false;
  try {
    tagExists = !!git("tag", "-l", tag) || (o.publish && !!git("ls-remote", "--tags", "origin", `refs/tags/${tag}`));
  } catch {
    /* no remote: local tags only */
  }
  const releaseKey = envReleaseKey();
  let releasePub = false;
  if (releaseKey && exists("security/release-key.pub")) {
    try {
      releasePub = parsePublicKey(read("security/release-key.pub")).pk.equals(rawPublicKey(readSecretKey(releaseKey.pem, releaseKey.passphrase)));
    } catch {
      releasePub = false;
    }
  }
  const pub = envUpdaterPub();
  const nf = notesFiles(o.version);
  const nonEmpty = (p) => exists(p) && read(p).trim().length > 0;
  return {
    current: JSON.parse(read("package.json")).version,
    tagExists,
    repo,
    nodeModules: exists("node_modules/.bin/vite"),
    cargo: tryRun("cargo", ["--version"]),
    tauriCli: exists("node_modules/.bin/tauri"),
    notes: { he: nonEmpty(nf.he), en: nonEmpty(nf.en) },
    clean: git("status", "--porcelain") === "",
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    gh: o.publish ? tryRun("gh", ["auth", "status"]) : false,
    updaterKey: !!(process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim(),
    updaterPub: !!pub,
    updaterPubIsTest: !!pub && isTestKey(pub),
    releaseKey: !!releaseKey,
    releasePub,
  };
}

function bundlesFromTarget(version) {
  const target = path.join(ROOT, "src-tauri", "target");
  if (!existsSync(target)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!name.endsWith(".app")) walk(full);
      } else if (/[/\\]release[/\\]bundle[/\\]/.test(full) && /\.(dmg|msi|exe|deb|rpm|AppImage|tar\.gz|sig)$/i.test(name) && isBundleOf(name, version)) out.push(full);
    }
  };
  walk(target);
  return out.map((full) => ({ name: macUpdateName(path.basename(full), version, process.arch), data: readFileSync(full) }));
}

export async function main(argv) {
  const o = parseRunArgs(argv);
  const repo = repoSlug();
  const v = o.version;
  const tag = tagOf(v);
  const channel = isBeta(v) ? "beta" : "stable";
  console.log(`Lumen release ${v} (${channel}) — ${o.publish ? "PUBLISH" : "dry run"}${o.fakeBuild ? ", fake build" : ""}`);

  step(1, "preflight");
  const f = facts(o, repo);
  const items = preflight(o, f);
  for (const i of items) console.log(`${i.ok ? "✓" : i.blocking ? "✗" : "·"} ${i.what}${i.ok ? "" : `\n    → ${i.fix}`}`);
  const blocking = items.filter((i) => i.blocking);
  if (blocking.length) throw new Error(`${blocking.length} preflight item(s) missing — fix the ✗ lines above and run again`);

  const original = new Map();
  const write = (p, text) => {
    if (!original.has(p)) original.set(p, exists(p) ? read(p) : null);
    mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true });
    writeFileSync(path.join(ROOT, p), text);
  };
  const putBack = (only) => {
    for (const [p, text] of original) {
      if (only && !only.includes(p)) continue;
      if (text === null) rmSync(path.join(ROOT, p), { force: true });
      else writeFileSync(path.join(ROOT, p), text);
      original.delete(p);
    }
  };
  const temp = mkdtempSync(path.join(tmpdir(), "lumen-release-"));
  let committed = false;
  try {
    step(2, `version ${f.current} → ${v}, changelog from merged pull requests`);
    const files = Object.fromEntries(MANIFESTS.filter(exists).map((p) => [p, read(p)]));
    for (const [p, text] of Object.entries(bumpManifests(files, v))) write(p, text);
    const since = lastTag(channel === "stable");
    if (git("rev-parse", "--is-shallow-repository") === "true") warn("this clone is shallow: the changelog may miss older PRs (git fetch --unshallow)");
    const log = git("log", "--format=%H%x1f%s%x1f%b%x1e", ...(since ? [`${since}..HEAD`] : ["HEAD"]));
    const titles = prTitles(repo, o.offline);
    const entries = mergedPrs(log).map((pr) => prEntry(pr, titles));
    const section = prChangelogSection(v, entries, { repo });
    write("CHANGELOG.md", insertChangelog(exists("CHANGELOG.md") ? read("CHANGELOG.md") : "", section));
    for (const p of LOCALES.filter((l) => l !== "en").map((l) => `changelog/${l}.md`).filter(exists)) write(p, addUntranslated(read(p), section));
    console.log(`${entries.length} merged pull requests since ${since ?? "the first commit"}; files: ${[...original.keys()].join(", ")}`);

    if (o.publish) {
      step(3, `commit and tag ${tag}`);
      git("add", ...original.keys());
      git("-c", "core.hooksPath=/dev/null", "commit", "-m", `chore(release): ${v}`);
      git("tag", "-a", tag, "-m", `Lumen ${v}`);
      original.clear(); // committed: nothing to put back
      committed = true;
    } else step(3, "commit and tag — skipped (dry run)");

    // Keys: the owner's, or (dry run) throwaway ones.
    let updater = null;
    const realPub = envUpdaterPub();
    if (o.fakeBuild || !f.updaterKey || !realPub) {
      if (o.publish) throw new Error("no updater key"); // preflight already stops this
      const k = testUpdaterKey(() => generateKeys());
      updater = { pem: k.pem, pubkey: k.pubkey, test: true };
      console.log(`updater key: throwaway TEST key (${o.fakeBuild ? "fake build" : "no TAURI_SIGNING_PRIVATE_KEY / LUMEN_UPDATER_PUBKEY"})`);
    } else updater = { pem: null, pubkey: realPub, test: false };
    let release = envReleaseKey();
    let releasePubText;
    if (release) releasePubText = formatPublicKey(rawPublicKey(readSecretKey(release.pem, release.passphrase)));
    else {
      const k = generateKeys();
      release = { pem: k.pem, passphrase: undefined, test: true };
      releasePubText = k.publicKey.replace("minisign public key", "minisign public key TEST");
      console.log("release key: throwaway TEST key (no LUMEN_RELEASE_KEY)");
    }

    step(4, "updater: fill the placeholder in tauri.conf.json");
    const conf = fillUpdater(JSON.parse(read(CONF)), { pubkey: updater.pubkey, repo, channel });
    write(CONF, JSON.stringify(conf, null, 2) + "\n");
    console.log(`pubkey set (${updater.test ? "TEST" : "owner's"} key), endpoint ${conf.plugins.updater.endpoints[0]}`);

    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const channelEnv = { VITE_LUMEN_CHANNEL: channel };

    step(5, "web build (reproducible)");
    if (o.checks && !o.fakeBuild) {
      run("npm", ["run", "typecheck"]);
      run("npm", ["test"]);
    }
    if (!o.fakeBuild) run("npm", ["run", "flags:check"]);
    const buildCmd = o.fakeBuild ? "node scripts/release-fake-build.mjs" : "npm run build";
    if (o.repro) run("node", ["scripts/supply-chain/repro-check.mjs", "--build", buildCmd], channelEnv);
    else run(...(o.fakeBuild ? ["node", ["scripts/release-fake-build.mjs"]] : ["npm", ["run", "build"]]), channelEnv);
    if (!o.fakeBuild) {
      run("npm", ["run", "budget"]);
      run("node", ["scripts/check-sourcemaps.mjs", "dist"]);
    }
    const epoch = Math.floor(sourceDate(ROOT).getTime() / 1000);
    const dist = path.join(ROOT, "dist");
    const tgz = reproducibleTgz(filesUnder(dist).map((p) => ({ path: p, data: readFileSync(path.join(dist, p)) })), epoch);
    writeFileSync(path.join(OUT, `lumen-web-${tag}.tgz`), tgz);
    console.log(`lumen-web-${tag}.tgz: ${tgz.length} bytes`);

    let latest = null;
    if (o.desktop) {
      step(6, "desktop bundles, signed for the updater");
      let bundles;
      if (o.fakeBuild) bundles = fakeDesktop(v, updater.pem);
      else {
        const override = path.join(temp, "tauri.release.json");
        // dist/ is already built (and checked) above: tauri must not rebuild it.
        writeFileSync(override, JSON.stringify({ build: { beforeBuildCommand: "" } }));
        const extra = ["--config", override, ...(isBeta(v) && process.platform === "win32" ? ["--bundles", "nsis"] : [])];
        run("npm", ["run", "tauri:build", "--", ...extra], { ...channelEnv, ...updaterBuildEnv({ pubkey: updater.pubkey, repo }) });
        bundles = bundlesFromTarget(v);
      }
      for (const b of bundles) writeFileSync(path.join(OUT, b.name), b.data);
      const sigs = bundles.filter((b) => b.name.endsWith(".sig")).map((b) => ({ name: b.name, signature: b.data.toString("utf8") }));
      if (!sigs.length) throw new Error("tauri build made no .sig files: is TAURI_SIGNING_PRIVATE_KEY set and createUpdaterArtifacts on?");
      const he = exists(notesFiles(v).he) ? read(notesFiles(v).he) : "";
      const en = exists(notesFiles(v).en) ? read(notesFiles(v).en) : "";
      latest = latestJson({ tag, repo, sigs, notes: shortNotes({ version: v, he, en }), date: new Date(epoch * 1000) });
      const byName = new Map(bundles.map((b) => [b.name, b.data]));
      const problems = checkLatest(latest, byName, updater.pubkey);
      if (problems.length) throw new Error(`latest.json does not verify:\n  ${problems.join("\n  ")}`);
      writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
      // The same check the app makes must refuse a changed file.
      const [p0, e0] = Object.entries(latest.platforms)[0];
      const name0 = decodeURIComponent(e0.url.split("/").pop());
      const changed = Buffer.from(byName.get(name0));
      changed[changed.length - 1] ^= 1;
      let refused = false;
      try {
        verifyTauriSig(changed, e0.signature, updater.pubkey);
      } catch {
        refused = true;
      }
      if (!refused) throw new Error(`tamper check: a changed ${name0} still verified`);
      console.log(`latest.json: ${Object.keys(latest.platforms).join(", ")} — every signature verifies with the updater key; a changed byte in ${name0} (${p0}) is refused`);
    } else step(6, "desktop — skipped (--no-desktop)");

    step(7, "SBOM (CycloneDX, offline)");
    const sbom = buildSbom(ROOT);
    writeFileSync(path.join(OUT, "sbom.cdx.json"), JSON.stringify(sbom, null, 2) + "\n");
    console.log(`sbom.cdx.json: ${sbom.components.length} components`);

    step(8, "release notes (Hebrew, English)");
    const nf = notesFiles(v);
    const heText = exists(nf.he) ? read(nf.he) : "";
    const enText = exists(nf.en) ? read(nf.en) : "";
    if (heText.trim() && enText.trim()) {
      writeFileSync(path.join(OUT, "RELEASE_NOTES.md"), bilingualNotes({ version: v, he: heText, en: enText, changelog: section, repo }));
      console.log("RELEASE_NOTES.md written");
    } else warn(`no ${nf.he} / ${nf.en}: a publish refuses this`);

    step(9, "SHA256SUMS, signed (minisign)");
    writeFileSync(path.join(OUT, "release-key.pub"), releasePubText);
    const assets = readdirSync(OUT).filter((n) => !n.startsWith(".") && !n.startsWith("SHA256SUMS") && !n.endsWith(".minisig") && n !== "RELEASE_NOTES.md" && n !== "DRY-RUN.md");
    const sums = sha256sums(assets.map((name) => ({ name, data: readFileSync(path.join(OUT, name)) })));
    writeFileSync(path.join(OUT, "SHA256SUMS"), sums);
    const commit = git("rev-parse", "HEAD");
    for (const name of ["SHA256SUMS", "sbom.cdx.json"]) {
      const trusted = `lumen-md ${v} commit:${commit} file:${name} timestamp:${epoch}`;
      writeFileSync(path.join(OUT, `${name}.minisig`), signData(readFileSync(path.join(OUT, name)), release.pem, { passphrase: release.passphrase, trusted }));
    }
    const r = verifyRelease({ dir: OUT, root: ROOT, pub: releasePubText });
    if (!r.ok) throw new Error(`the release does not verify: ${r.errors.join("; ")}`);
    const tampered = Buffer.from(sums.replace(/^./, (c) => (c === "0" ? "1" : "0")));
    let sumsRefused = false;
    try {
      verifyData(tampered, readFileSync(path.join(OUT, "SHA256SUMS.minisig"), "utf8"), releasePubText);
    } catch {
      sumsRefused = true;
    }
    if (!sumsRefused || verifySums(sums, [{ name: assets[0], data: Buffer.from("changed") }]).length === 0) throw new Error("tamper check on SHA256SUMS failed");
    console.log(`verified: ${r.checked} files match SHA256SUMS; SHA256SUMS and sbom.cdx.json signed by ${release.test ? "a TEST" : "the release"} key ${r.keyId}; a changed SHA256SUMS is refused`);

    // W7.22: how it was built (SLSA provenance, the build key) and who released it (keyless Sigstore).
    // On --publish the tree must be exactly the tagged commit first: the policy refuses a dirty tree.
    step("9b", `build provenance and Sigstore bundles${o.publish ? "" : " (TEST keys and the local Sigstore stand-in)"}`);
    if (o.publish) putBack([CONF]);
    const gate = provenanceGate({ out: OUT, root: ROOT, commit, publish: o.publish });
    if (gate.ok) console.log(`provenance gate: ${gate.files} files, each built by a trusted host and signed by ${gate.test ? "a TEST identity" : "the release identity"}\n${gate.log}`);
    else if (!o.publish && gate.unavailable) warn(`provenance gate not checked here (no Sigstore verifier on this machine): ${gate.log}`);
    else throw new Error(`provenance gate: ${gate.log}`);

    const uploads = readdirSync(OUT).filter((n) => !n.startsWith(".") && n !== "RELEASE_NOTES.md" && n !== "DRY-RUN.md").sort();
    const commands = publishCommands({ version: v, repo, assets: uploads });
    if (o.publish) {
      step(10, "publish");
      putBack([CONF]);
      run("git", ["push", "origin", "HEAD", tag]);
      run("gh", ["release", "create", tag, "--repo", repo, "--title", `Lumen ${v}`, "--notes-file", path.join(OUT, "RELEASE_NOTES.md"), "--verify-tag", ...(isBeta(v) ? ["--prerelease", "--latest=false"] : []), ...uploads.map((a) => path.join(OUT, a))]);
      if (latest) betaChannel(repo, v, latest);
      console.log(`\nPublished ${tag}: https://github.com/${repo}/releases/tag/${tag}\nAnyone can check it: node scripts/supply-chain/verify-release.mjs <download dir> --pub security/release-key.pub`);
    } else {
      step(10, "publish — not run (dry run); --publish would run:");
      for (const c of commands) console.log(`  ${c}`);
      const report = [
        `# Release dry run: Lumen ${v}`,
        "",
        `- commit ${commit}, ${new Date().toISOString()}`,
        `- keys: updater ${updater.test ? "TEST (throwaway)" : "owner's"}, release ${release.test ? "TEST (throwaway)" : "owner's"}${o.fakeBuild ? "; FAKE build (stand-in bundles)" : ""}`,
        `- ${entries.length} merged pull requests in the changelog`,
        "",
        "## Assets",
        "",
        ...uploads.map((n) => `- ${n} (${statSync(path.join(OUT, n)).size} bytes)`),
        "",
        "## --publish would run",
        "",
        "```bash",
        ...commands,
        "```",
        "",
      ].join("\n");
      writeFileSync(path.join(OUT, "DRY-RUN.md"), report);
      writeFileSync(path.join(OUT, ".updater-key.pub"), `${updater.pubkey}\n`); // to check latest.json by hand; never uploaded
      if (o.fakeBuild) writeFileSync(path.join(OUT, ".FAKE-BUILD"), "stand-in bundles: never publish this folder\n");
      console.log(`\nDry run OK: release/ has ${uploads.length} assets (see release/DRY-RUN.md); the working tree is put back.`);
    }
  } catch (e) {
    if (committed) console.error(`\nThe release commit and tag ${tag} are local only. To undo: git tag -d ${tag} && git reset --hard HEAD~1`);
    throw e;
  } finally {
    putBack();
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Point the rolling beta-channel release at this version when it is newer (plan 14.4); merge platforms uploaded from another machine. */
function betaChannel(repo, version, latest) {
  const dir = mkdtempSync(path.join(tmpdir(), "lumen-beta-"));
  let have = null;
  try {
    execFileSync("gh", ["release", "download", "beta-channel", "--repo", repo, "--pattern", "latest.json", "--dir", dir], { stdio: "ignore" });
    have = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  } catch {
    if (!tryRun("gh", ["release", "view", "beta-channel", "--repo", repo])) run("gh", ["release", "create", "beta-channel", "--repo", repo, "--prerelease", "--latest=false", "--title", "Beta channel", "--notes", "Rolling pointer for the desktop beta update channel (plan 14.4). Not a release: its latest.json names the newest beta or stable release."]);
  }
  if (have && compareVersions(version, have.version) < 0) {
    console.log(`beta channel stays on ${have.version} (newer than ${version})`);
  } else {
    const next = have && have.version === version ? mergeLatest(have, latest) : latest;
    writeFileSync(path.join(dir, "latest.json"), JSON.stringify(next, null, 2) + "\n");
    run("gh", ["release", "upload", "beta-channel", "--repo", repo, path.join(dir, "latest.json"), "--clobber"]);
    console.log(`beta channel → ${version} (${Object.keys(next.platforms).join(", ")})`);
  }
  rmSync(dir, { recursive: true, force: true });
}

