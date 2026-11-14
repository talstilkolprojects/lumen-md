/**
 * W11.S2 / W11.S3 (research R3.2, CVE-2026-95625): an updater that does not
 * trust the manifest.
 *
 *  - The release signs latest.json itself (latest.json.sig, the updater key,
 *    Tauri's .sig format) and refuses to publish without a signature that
 *    verifies (scripts/lib/releaseRun.mjs, scripts/release-run.mjs).
 *  - The app verifies that signature before it reads the manifest, reads the
 *    version from the verified bytes, refuses anything not newer than the
 *    running build and the highest ever installed, and installs only the
 *    update its last check verified (src-tauri/src/manifest_sig.rs,
 *    updates.rs). Its rules run here with rustc when rustc is installed.
 *  - The WebView holds no updater permission, and the update commands take
 *    no parameters.
 *
 * The vectors (src-tauri/tests/fixtures/manifest-sig-vectors.json) are
 * synthetic, made with a throwaway key by
 * scripts/supply-chain/manifest-sig-vectors.mjs.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import { MANIFEST_SIG, manifestProblems, signManifest, testUpdaterKey, verifyTauriSig } from "../../scripts/lib/releaseRun.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { generateKeys } from "../../scripts/supply-chain/minisign.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { makeVectors } from "../../scripts/supply-chain/manifest-sig-vectors.mjs";

const ROOT = resolve(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

type Case = { name: string; manifest: string; sig: string | null; pubkey?: string; expect: string };
type Vectors = { pubkey: string; cases: Case[] };

/** The order of src-tauri/src/manifest_sig.rs `verify_manifest`, with the release's Node verifier as the Ed25519 check. */
function classify(manifest: string, sig: string | null, pubkey: string): string {
  if (sig === null || !sig.trim()) return "unsigned";
  if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(sig)) return "malformed";
  if (!pubkey.trim()) return "malformed";
  try {
    verifyTauriSig(Buffer.from(manifest), sig, pubkey);
    return "ok";
  } catch {
    return "bad-signature";
  }
}

const key = () => testUpdaterKey(() => generateKeys()) as { pem: string; pubkey: string };
const manifest = Buffer.from(JSON.stringify({ version: "0.3.0", notes: "", pub_date: "2026-11-15T00:00:00Z", platforms: {} }, null, 2) + "\n");

describe("the release signs latest.json and will not publish it unsigned (W11.S3)", () => {
  it("a manifest signed by the release verifies with the updater key", () => {
    const k = key();
    const sig = signManifest(manifest, k, { timestamp: 1 });
    expect(manifestProblems(new Map([["latest.json", manifest], [MANIFEST_SIG, Buffer.from(sig + "\n")]]), k.pubkey)).toEqual([]);
  });

  it("publishing without latest.json.sig fails", () => {
    const k = key();
    expect(manifestProblems(new Map([["latest.json", manifest]]), k.pubkey).join()).toMatch(/latest\.json\.sig is missing/);
    expect(manifestProblems(new Map([["latest.json", manifest], [MANIFEST_SIG, Buffer.from("\n")]]), k.pubkey).join()).toMatch(/missing/);
  });

  it("a signature that does not verify fails: other key, changed manifest, junk", () => {
    const k = key();
    const other = key();
    const sig = signManifest(manifest, k, { timestamp: 1 });
    const changed = Buffer.from(manifest.toString().replace("0.3.0", "0.3.1"));
    expect(manifestProblems(new Map([["latest.json", changed], [MANIFEST_SIG, Buffer.from(sig)]]), k.pubkey).join()).toMatch(/does not verify/);
    expect(manifestProblems(new Map([["latest.json", manifest], [MANIFEST_SIG, Buffer.from(sig)]]), other.pubkey).join()).toMatch(/does not verify/);
    expect(manifestProblems(new Map([["latest.json", manifest], [MANIFEST_SIG, Buffer.from("bm90IGEgc2ln")]]), k.pubkey).join()).toMatch(/does not verify/);
  });

  it("a release with no desktop part (no latest.json) has nothing to sign", () => {
    expect(manifestProblems(new Map(), key().pubkey)).toEqual([]);
  });

  it("the owner's key is used through `tauri signer sign`, and its output is checked too", () => {
    const k = key();
    const real = { pem: null, pubkey: k.pubkey };
    expect(() => signManifest(manifest, real, {})).toThrow(/no updater secret key/);
    // A signer that returns a signature for other bytes is caught before anything is written.
    const wrong = signManifest(Buffer.from("other"), k, { timestamp: 1 });
    expect(() => signManifest(manifest, real, { file: "x", tauriSigner: () => wrong })).toThrow();
    const right = signManifest(manifest, k, { timestamp: 1 });
    expect(signManifest(manifest, real, { file: "x", tauriSigner: () => right + "\n" })).toBe(right);
  });

  it("release-run signs latest.json, re-signs the merged beta manifest and checks both before any upload", () => {
    const run = read("scripts/release-run.mjs");
    expect(run).toMatch(/writeFileSync\(path\.join\(OUT, MANIFEST_SIG\), signManifest\(/);
    expect(run).toMatch(/writeFileSync\(path\.join\(dir, MANIFEST_SIG\), signManifest\(/);
    // The gate sits before step 10, and so before `gh release create`.
    const gate = run.indexOf("const unsigned = manifestProblems(");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(run.indexOf('step(10, "publish")'));
    expect(run.indexOf("manifestProblems(", run.indexOf("function betaChannel"))).toBeLessThan(run.indexOf('"upload", "beta-channel"'));
  });
});

describe("the signature vectors the Rust side checks (W11.S2 × W11.S3)", () => {
  const vectors = JSON.parse(read("src-tauri/tests/fixtures/manifest-sig-vectors.json")) as Vectors;

  it("every committed case gives its expected result", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of vectors.cases) expect(classify(c.manifest, c.sig, c.pubkey ?? vectors.pubkey), c.name).toBe(c.expect);
    expect(new Set(vectors.cases.map((c) => c.expect))).toEqual(new Set(["ok", "unsigned", "bad-signature", "malformed"]));
  });

  it("a fresh set from the generator behaves the same (the file is not hand-edited)", () => {
    const fresh = makeVectors() as Vectors;
    expect(fresh.cases.map((c) => [c.name, c.expect])).toEqual(vectors.cases.map((c) => [c.name, c.expect]));
    for (const c of fresh.cases) expect(classify(c.manifest, c.sig, c.pubkey ?? fresh.pubkey), c.name).toBe(c.expect);
  });

  it("the Rust test reads this file and uses the real minisign check", () => {
    const rs = read("src-tauri/src/updates.rs");
    expect(rs).toMatch(/include_str!\("\.\.\/tests\/fixtures\/manifest-sig-vectors\.json"\)/);
    expect(rs).toMatch(/verify_manifest\(manifest, sig, field\("pubkey"\)\.unwrap_or\(key\), minisign_check\)/);
    expect(rs).toMatch(/minisign_verify::PublicKey::decode\(key_text\)/);
  });
});

describe("the app does not trust the manifest (W11.S2)", () => {
  const rs = read("src-tauri/src/updates.rs");
  const imp = rs.slice(rs.indexOf("pub mod imp"), rs.indexOf("#[cfg(test)]"));

  it("the signature is verified before the manifest is read, and the version comes from the verified bytes", () => {
    const check = imp.slice(imp.indexOf("pub async fn lumen_check_update"), imp.indexOf("pub async fn lumen_install_update"));
    const verify = check.indexOf("manifest_sig::verify_manifest(&manifest, sig.as_deref(), key, minisign_check)");
    const parse = check.indexOf("serde_json::from_slice(&manifest)");
    const guard = check.indexOf("update_guard::accept(&current, version, recorded.as_deref())");
    const plugin = check.indexOf(".check().await");
    expect(verify).toBeGreaterThan(0);
    expect(parse).toBeGreaterThan(verify);
    expect(guard).toBeGreaterThan(parse);
    expect(plugin).toBeGreaterThan(guard);
    // What the plugin fetched for the install must be the verified manifest.
    expect(check).toMatch(/if up\.raw_json != verified \{\s*return Err\(/);
    expect(check).toMatch(/\.version_comparator\(move \|current, remote\| update_guard::accept\(/);
  });

  it("the update commands take nothing from the WebView, and install only what the check verified", () => {
    expect(imp).toMatch(/pub async fn lumen_check_update\(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>\)/);
    expect(imp).toMatch(/pub async fn lumen_install_update\(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>\)/);
    expect(imp).toMatch(/let up = pending\.0\.lock\(\)[^\n]*\.take\(\);/);
    expect(imp).not.toMatch(/fn update_(check|install)\b/);
    expect(imp.match(/updater_builder\(\)/g)).toHaveLength(1);
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).toMatch(/updates::imp::lumen_check_update,/);
    expect(lib).toMatch(/updates::imp::lumen_install_update,/);
    expect(lib).toMatch(/\.manage\(updates::imp::PendingUpdate::default\(\)\)/);
    expect(lib).toMatch(/^mod manifest_sig;$/m);
  });

  it("allowDowngrades is off and tauri-plugin-updater is ≥ 2.13.3", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.plugins.updater.allowDowngrades).toBe(false);
    const v = /^tauri-plugin-updater = "(\d+)\.(\d+)\.(\d+)"$/m.exec(read("src-tauri/Cargo.toml"))!.slice(1).map(Number);
    expect(v[0] * 1e6 + v[1] * 1e3 + v[2]).toBeGreaterThanOrEqual(2013003);
    expect(read("src-tauri/Cargo.toml")).toMatch(/^minisign-verify = "0\.3\.0"$/m);
  });

  it("capabilities snapshot: no updater (or shell, fs, http) permission in any WebView capability", () => {
    const dir = join(ROOT, "src-tauri/capabilities");
    const snapshot: Record<string, string[]> = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const cap = JSON.parse(readFileSync(join(dir, f), "utf8")) as { permissions: Array<string | { identifier: string }> };
      snapshot[f] = cap.permissions.map((p) => (typeof p === "string" ? p : p.identifier));
    }
    expect(snapshot).toEqual({
      "default.json": ["core:default", "dialog:default", "core:window:allow-show", "core:window:allow-unminimize", "core:window:allow-set-focus", "deep-link:default"],
    });
    expect(Object.values(snapshot).flat().filter((p) => /^(updater|shell|fs|http):/.test(p))).toEqual([]);
  });
});

describe("the Rust rules, compiled and run (rustc --test, no dependencies)", () => {
  const rustc = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  it.skipIf(rustc.status !== 0)("manifest_sig.rs and update_guard.rs pass their own tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifest-sig-"));
    try {
      for (const m of ["manifest_sig", "update_guard"]) {
        const bin = join(dir, m);
        const c = spawnSync("rustc", ["--edition", "2021", "--test", join(ROOT, `src-tauri/src/${m}.rs`), "-o", bin], { encoding: "utf8", timeout: 240_000 });
        expect(c.status, c.stderr).toBe(0);
        const r = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000 });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toMatch(/test result: ok\. \d+ passed; 0 failed/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
