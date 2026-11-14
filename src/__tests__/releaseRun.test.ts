/**
 * Plan W4.5 — the one-command release (`npm run release -- <version> --dry-run | --publish`):
 * the updater placeholder and its gate, Tauri update signatures (a changed
 * byte is refused), latest.json, the changelog from merged PRs, bilingual
 * notes, a byte-reproducible web .tgz, the preflight, and a whole dry run
 * with a fake build in a scratch repository.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
// @ts-expect-error — plain .mjs helpers without types
import * as R from "../../scripts/lib/releaseRun.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { fakeDesktop, fakeWeb } from "../../scripts/lib/releaseFake.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { generateKeys } from "../../scripts/supply-chain/minisign.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { latestJson } from "../../scripts/lib/tauriSigning.mjs";

const ROOT = resolve(__dirname, "..", "..");
const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const REPO = "talstilkol/lumen-md";
const testKey = () => R.testUpdaterKey(() => generateKeys()) as { pem: string; pubkey: string };

describe("the updater placeholder (W4.5)", () => {
  it("the committed tauri.conf.json has the placeholder and a GitHub Releases endpoint", () => {
    expect(conf.plugins.updater.pubkey).toBe(R.PUBKEY_PLACEHOLDER);
    expect(conf.plugins.updater.endpoints).toEqual([`https://github.com/${REPO}/releases/latest/download/latest.json`]);
    expect(R.checkUpdaterConf(conf)).toEqual([]);
  });

  it("a release build fails on the placeholder, on an empty key and on a key that is not one", () => {
    expect(R.checkUpdaterConf(conf, { release: true }).join("; ")).toMatch(/still the placeholder/);
    const empty = structuredClone(conf);
    empty.plugins.updater.pubkey = "";
    expect(R.checkUpdaterConf(empty, { release: true }).join("; ")).toMatch(/is empty/);
    empty.plugins.updater.pubkey = Buffer.from("hello").toString("base64");
    expect(R.checkUpdaterConf(empty, { release: true }).join("; ")).toMatch(/not a minisign key/);
    expect(() => R.fillUpdater(conf, { pubkey: "", repo: REPO, channel: "beta" })).toThrow(/empty/);
  });

  it("the release fills the key and the channel's endpoint, and turns on signed update bundles", () => {
    const { pubkey } = testKey();
    const beta = R.fillUpdater(conf, { pubkey, repo: REPO, channel: "beta" });
    expect(beta.plugins.updater.pubkey).toBe(pubkey);
    expect(beta.plugins.updater.endpoints).toEqual([`https://github.com/${REPO}/releases/download/beta-channel/latest.json`]);
    expect(beta.bundle.createUpdaterArtifacts).toBe(true);
    expect(R.checkUpdaterConf(beta, { release: true })).toEqual([]);
    expect(R.fillUpdater(conf, { pubkey, repo: REPO, channel: "stable" }).plugins.updater.endpoints[0]).toMatch(/releases\/latest\/download\/latest\.json$/);
    expect(conf.plugins.updater.pubkey).toBe(R.PUBKEY_PLACEHOLDER); // the input is not changed
    // The Rust shell is compiled with the same three settings (src-tauri/src/updates.rs).
    const env = R.updaterBuildEnv({ pubkey, repo: REPO });
    const rs = readFileSync(join(ROOT, "src-tauri/src/updates.rs"), "utf8");
    for (const k of Object.keys(env)) expect(rs).toContain(`option_env!("${k}")`);
  });

  it("takes the key as tauri writes it (base64) or as the minisign text, and knows a test key", () => {
    const { publicKey } = generateKeys();
    const b64 = R.normalizeUpdaterPubkey(publicKey);
    expect(R.normalizeUpdaterPubkey(b64)).toBe(b64);
    expect(R.isTestKey(b64)).toBe(false);
    expect(R.isTestKey(testKey().pubkey)).toBe(true);
    expect(() => R.updaterEndpoints("not a repo")).toThrow();
  });
});

describe("update signatures and latest.json (W4.5)", () => {
  it("a Tauri .sig verifies its file, and a changed byte or another key is refused", () => {
    const k = testKey();
    const data = Buffer.from("bundle bytes");
    const sig = R.tauriSign(data, k.pem, "Lumen_1.0.0_amd64.AppImage");
    expect(R.verifyTauriSig(data, sig, k.pubkey)).toMatch(/file:Lumen_1\.0\.0_amd64\.AppImage/);
    const changed = Buffer.from(data);
    changed[0] ^= 1;
    expect(() => R.verifyTauriSig(changed, sig, k.pubkey)).toThrow(/does not match/);
    expect(() => R.verifyTauriSig(data, sig, testKey().pubkey)).toThrow(/Signed with key/);
  });

  it("latest.json from the bundles has three platforms, all verified; a changed or missing bundle is a problem", () => {
    const k = testKey();
    const v = "0.2.0-beta.1";
    const bundles: { name: string; data: Buffer }[] = fakeDesktop(v, k.pem);
    const sigs = bundles.filter((b) => b.name.endsWith(".sig")).map((b) => ({ name: b.name, signature: b.data.toString() }));
    const latest = latestJson({ tag: `v${v}`, repo: REPO, sigs, notes: "n", date: new Date(0) });
    expect(Object.keys(latest.platforms).sort()).toEqual(["darwin-aarch64", "linux-x86_64", "windows-x86_64"]);
    const files = new Map(bundles.map((b) => [b.name, b.data]));
    expect(R.checkLatest(latest, files, k.pubkey)).toEqual([]);
    const name = `Lumen_${v}_amd64.AppImage`;
    const bad = new Map(files);
    bad.set(name, Buffer.concat([files.get(name) as Buffer, Buffer.from("x")]));
    expect(R.checkLatest(latest, bad, k.pubkey).join()).toMatch(/linux-x86_64: .*does not match/);
    bad.delete(name);
    expect(R.checkLatest(latest, bad, k.pubkey).join()).toMatch(/not in the release/);
    expect(R.checkLatest(latest, files, testKey().pubkey)).toHaveLength(3);
  });

  it("names the macOS update bundle with its version and architecture, and keeps old bundles out", () => {
    expect(R.macUpdateName("Lumen.app.tar.gz", "0.2.0", "arm64")).toBe("Lumen_0.2.0_aarch64.app.tar.gz");
    expect(R.macUpdateName("Lumen.app.tar.gz.sig", "0.2.0", "x64")).toBe("Lumen_0.2.0_x64.app.tar.gz.sig");
    expect(R.macUpdateName("Lumen_0.2.0_amd64.AppImage", "0.2.0", "x64")).toBe("Lumen_0.2.0_amd64.AppImage");
    expect(R.isBundleOf("Lumen_0.1.0_amd64.deb", "0.2.0")).toBe(false);
    expect(R.isBundleOf("Lumen_0.2.0_amd64.deb", "0.2.0")).toBe(true);
  });

  it("merges latest.json from two machines of the same version only", () => {
    const a = { version: "1.0.0", notes: "", pub_date: "2026-01-01T00:00:00.000Z", platforms: { "darwin-aarch64": { url: "u1", signature: "s1" } } };
    const b = { version: "1.0.0", notes: "", pub_date: "2026-01-02T00:00:00.000Z", platforms: { "linux-x86_64": { url: "u2", signature: "s2" } } };
    expect(Object.keys(R.mergeLatest(a, b).platforms)).toEqual(["darwin-aarch64", "linux-x86_64"]);
    expect(R.mergeLatest(a, b).pub_date).toBe(b.pub_date);
    expect(() => R.mergeLatest(a, { ...b, version: "1.0.1" })).toThrow(/differ/);
  });
});

describe("changelog from merged pull requests (W4.5)", () => {
  const rec = (h: string, s: string, b = "") => `${h}\x1f${s}\x1f${b}\x1e`;
  const log = [
    rec("c3", "fix(sync): keep the cursor (#12)"),
    rec("c2", "Merge #11 feat/beta-channel [skip ci]"),
    rec("c1", "Merge pull request #10 from talstilkol/feat/updater", "feat(desktop): updater\n"),
    rec("c0", "Merge pull request #10 from talstilkol/feat/updater", "feat(desktop): updater\n"),
  ].join("\n");

  it("finds GitHub merges, squash merges and train merges, oldest first, each PR once", () => {
    const prs = R.mergedPrs(log);
    expect(prs.map((p: { number: number }) => p.number)).toEqual([10, 11, 12]);
    expect(prs[0]).toMatchObject({ title: "feat(desktop): updater", branch: "feat/updater" });
    expect(prs[1]).toMatchObject({ title: null, branch: "feat/beta-channel" });
  });

  it("titles from GitHub win; sections by type; every line links its PR", () => {
    const entries = R.mergedPrs(log).map((p: unknown) => R.prEntry(p, new Map([[11, "feat(release): beta channel (14.4) [skip ci]"]])));
    const s = R.prChangelogSection("0.2.0-beta.1", entries, { date: new Date("2026-11-12T00:00:00Z"), repo: REPO });
    expect(s).toMatch(/^## \[0\.2\.0-beta\.1\] - 2026-11-12\n/);
    expect(s).toMatch(/### Added\n\n- \*\*desktop:\*\* updater \(\[#10\]\(https:\/\/github\.com\/talstilkol\/lumen-md\/pull\/10\)\)\n- \*\*release:\*\* beta channel \(14\.4\) \(\[#11\]/);
    expect(s).toMatch(/### Fixed\n\n- \*\*sync:\*\* keep the cursor/);
    expect(s).not.toMatch(/skip ci/);
    const other = R.prEntry({ number: 5, branch: "chore/x", title: "14.6: What's new" });
    expect(other.type).toBe("other");
    expect(R.prChangelogSection("1.0.0", [other])).toMatch(/### Other changes\n\n- 14\.6: What's new \(#5\)/);
  });
});

describe("release notes in Hebrew and English (W4.5)", () => {
  it("Hebrew first, right to left, then English, then every change; both languages are required", () => {
    const n = R.bilingualNotes({ version: "0.2.0-beta.1", he: "שלום", en: "Hello", changelog: "## [0.2.0-beta.1] - d\n\n### Added\n\n- x\n", repo: REPO });
    expect(n.indexOf("שלום")).toBeLessThan(n.indexOf("Hello"));
    expect(n).toMatch(/<div dir="rtl" lang="he">/);
    expect(n).toMatch(/גרסת בטא/);
    expect(n).toMatch(/minisign -Vm SHA256SUMS -p release-key\.pub/);
    expect(n).toMatch(/### Added\n\n- x/);
    expect(() => R.bilingualNotes({ version: "1.0.0", he: "", en: "Hello", changelog: "", repo: REPO })).toThrow(/release-notes\/1\.0\.0\.he\.md/);
    expect(R.shortNotes({ version: "1", he: "# t\n\nשורה\n\nעוד", en: "Line" })).toBe("שורה\n\nLine");
  });

  it("the notes of 0.2.0-beta.1 exist in both languages", () => {
    const f = R.notesFiles("0.2.0-beta.1");
    expect(readFileSync(join(ROOT, f.he), "utf8")).toMatch(/[א-ת]{3}/);
    expect(readFileSync(join(ROOT, f.en), "utf8")).toMatch(/first public beta/);
  });
});

describe("a reproducible web .tgz (W4.5)", () => {
  const entries = fakeWeb("1.0.0", "beta").map((e: { path: string; data: Buffer }) => ({ path: e.path, data: e.data }));

  it("is the same bytes every time and in any order, with no time or OS in the gzip header", () => {
    const a = R.reproducibleTgz(entries, 1700000000);
    const b = R.reproducibleTgz([...entries].reverse(), 1700000000);
    expect(a.equals(b)).toBe(true);
    expect(a.readUInt32LE(4)).toBe(0);
    expect(a[9]).toBe(255);
    expect(R.reproducibleTgz(entries, 1700000001).equals(a)).toBe(false);
  });

  it("is a valid tar: names, sizes and contents read back", () => {
    const tar = gunzipSync(R.reproducibleTgz([...entries, { path: `${"d/".repeat(60)}long.js`, data: Buffer.from("x") }], 0));
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length; ) {
      const h = tar.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const str = (s: number, l: number) => h.subarray(s, s + l).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(str(124, 12), 8);
      const prefix = str(345, 155);
      names.push(prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      expect(parseInt(str(148, 8), 8)).toBe(sum);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual([...entries.map((e: { path: string }) => e.path).sort(), `${"d/".repeat(60)}long.js`].sort());
  });
});

describe("arguments and preflight (W4.5)", () => {
  it("--publish never takes a fake build; unknown options and both modes are refused", () => {
    expect(R.parseRunArgs(["0.2.0-beta.1"])).toMatchObject({ version: "0.2.0-beta.1", dryRun: true, publish: false, repro: true, desktop: true });
    expect(R.parseRunArgs(["v0.2.0-beta.1", "--publish"])).toMatchObject({ version: "0.2.0-beta.1", publish: true, dryRun: false });
    expect(() => R.parseRunArgs(["0.2.0-beta.1", "--publish", "--fake-build"])).toThrow(/never published/);
    expect(() => R.parseRunArgs(["0.2.0-beta.1", "--publish", "--dry-run"])).toThrow(/pick one/);
    expect(() => R.parseRunArgs(["0.2.0-beta.1", "--yes"])).toThrow(/unknown option --yes/);
    expect(() => R.parseRunArgs(["latest"])).toThrow(/semver/);
  });

  const base = { current: "0.1.0", tagExists: false, repo: REPO, nodeModules: false, cargo: false, tauriCli: false, notes: { he: true, en: true }, clean: true, branch: "main", gh: true, updaterKey: false, updaterPub: false, updaterPubIsTest: false, releaseKey: false, releasePub: false };

  it("a fake dry run needs no key and no toolchain", () => {
    const items = R.preflight(R.parseRunArgs(["0.2.0-beta.1", "--dry-run", "--fake-build"]), base);
    expect(items.filter((i: { blocking: boolean }) => i.blocking)).toEqual([]);
  });

  it("a publish names every missing key with the command that fixes it", () => {
    const items = R.preflight(R.parseRunArgs(["0.2.0-beta.1", "--publish"]), { ...base, updaterPub: true, updaterPubIsTest: true, clean: false, branch: "feat/x", notes: { he: false, en: true } });
    const blocking = items.filter((i: { blocking: boolean }) => i.blocking).map((i: { what: string; fix: string }) => `${i.what} → ${i.fix}`).join("\n");
    for (const re of [/node_modules.*npm ci/, /cargo/, /Tauri CLI/, /Hebrew and English/, /working tree is clean/, /releasing from main \(now on feat\/x\)/, /TAURI_SIGNING_PRIVATE_KEY.*tauri signer generate/, /real key.*security\/updater-key\.pub/, /LUMEN_RELEASE_KEY.*keys\.mjs/, /release-key\.pub is committed/]) expect(blocking).toMatch(re);
    expect(R.preflight(R.parseRunArgs(["0.1.0"]), base)[0]).toMatchObject({ ok: false, blocking: true });
    expect(R.preflight(R.parseRunArgs(["0.2.0"]), { ...base, tagExists: true })[1]).toMatchObject({ ok: false, blocking: true });
  });

  it("the publish plan pushes, makes a pre-release for a beta and points the beta channel", () => {
    const c = R.publishCommands({ version: "0.2.0-beta.1", repo: REPO, assets: ["SHA256SUMS", "latest.json"] });
    expect(c[0]).toBe("git push origin HEAD v0.2.0-beta.1");
    expect(c[1]).toMatch(/^gh release create v0\.2\.0-beta\.1 .*--verify-tag --prerelease --latest=false release\/SHA256SUMS release\/latest\.json$/);
    expect(c[2]).toMatch(/^gh release upload beta-channel/);
    expect(R.publishCommands({ version: "0.2.0", repo: REPO, assets: [] })[1]).not.toMatch(/prerelease/);
  });
});

describe("the whole dry run (W4.5)", () => {
  it("npm run release -- 0.2.0-beta.1 --dry-run --fake-build: every asset signed and verified, the tree left as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-release-run-"));
    try {
      for (const p of ["package.json", "package-lock.json", "CHANGELOG.md", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/src/updates.rs"]) {
        mkdirSync(join(dir, p, ".."), { recursive: true });
        cpSync(join(ROOT, p), join(dir, p));
      }
      for (const d of ["scripts", "release-notes", "changelog"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "/release/\n/dist/\n");
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" });
      git("init", "-q");
      git("remote", "add", "origin", `https://github.com/${REPO}.git`);
      git("add", "-A");
      git("commit", "-qm", "chore: base");
      git("commit", "-q", "--allow-empty", "-m", "feat(desktop): updater (#7)");
      const before = git("status", "--porcelain");
      const r = spawnSync(process.execPath, ["scripts/release.mjs", "0.2.0-beta.1", "--dry-run", "--fake-build", "--offline"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
      expect(`${r.stdout}${r.stderr}`).toMatch(/Dry run OK/);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/REPRODUCIBLE: 3 files/);
      expect(r.stdout).toMatch(/a changed byte in .* is refused/);
      expect(r.stdout).toMatch(/a changed SHA256SUMS is refused/);
      const out = readdirSync(join(dir, "release"));
      for (const f of ["SHA256SUMS", "SHA256SUMS.minisig", "sbom.cdx.json", "sbom.cdx.json.minisig", "latest.json", "RELEASE_NOTES.md", "lumen-web-v0.2.0-beta.1.tgz", "release-key.pub", "DRY-RUN.md", ".FAKE-BUILD"]) expect(out).toContain(f);
      expect(out.filter((n) => /\.(AppImage|dmg|exe|deb|app\.tar\.gz)$/.test(n)).length).toBeGreaterThanOrEqual(3);
      expect(readFileSync(join(dir, "release/DRY-RUN.md"), "utf8")).toMatch(/gh release create v0\.2\.0-beta\.1/);
      const v = spawnSync(process.execPath, ["scripts/supply-chain/verify-release.mjs", "release", "--pub", "release/release-key.pub"], { cwd: dir, encoding: "utf8" });
      expect(v.stdout).toMatch(/^OK: \d+ files match SHA256SUMS/);
      // Nothing committed, tagged or left changed.
      expect(git("status", "--porcelain")).toBe(before);
      expect(git("tag", "-l")).toBe("");
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
      expect(JSON.parse(readFileSync(join(dir, "src-tauri/tauri.conf.json"), "utf8")).plugins.updater.pubkey).toBe(R.PUBKEY_PLACEHOLDER);
      // A changed asset fails the check anyone can run.
      writeFileSync(join(dir, "release/lumen-web-v0.2.0-beta.1.tgz"), "changed");
      const v2 = spawnSync(process.execPath, ["scripts/supply-chain/verify-release.mjs", "release", "--pub", "release/release-key.pub"], { cwd: dir, encoding: "utf8" });
      expect(v2.status).toBe(1);
      expect(v2.stdout).toMatch(/lumen-web-v0\.2\.0-beta\.1\.tgz does not match SHA256SUMS/);
      expect(existsSync(join(dir, "dist", "index.html"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
