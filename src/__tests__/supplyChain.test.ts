/**
 * Signed releases and the SBOM (plan W1.27, scripts/supply-chain/): a key
 * is made, a release signed and checked, and every kind of tampering is
 * caught by the check anyone can run.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const script = (name: string) => join(ROOT, "scripts", "supply-chain", name);
const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumen-release-test-"));
  for (const f of ["package.json", "package-lock.json"]) copyFileSync(join(ROOT, f), join(dir, f));
  mkdirSync(join(dir, "src-tauri"));
  copyFileSync(join(ROOT, "src-tauri", "Cargo.lock"), join(dir, "src-tauri", "Cargo.lock"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><title>Lumen</title>");
  writeFileSync(join(dir, "dist", "assets", "app.js"), "console.log('שלום')");
  return dir;
}

describe("signed releases", () => {
  it("signs SHA256SUMS and the SBOM, verifies them, and catches a changed file, a changed list and another key", () => {
    const dir = fakeRepo();
    try {
      const env = { LUMEN_RELEASE_PASSPHRASE: "correct horse", SOURCE_DATE_EPOCH: "1794268800" };
      const keys = join(dir, "keys");
      expect(run(dir, [script("keys.mjs"), "--out", keys], env).status).toBe(0);
      mkdirSync(join(dir, "security"));
      copyFileSync(join(keys, "lumen-release.pub"), join(dir, "security", "release-key.pub"));

      const signed = run(dir, [script("release.mjs"), "--key", join(keys, "lumen-release.key")], env);
      expect(signed.status, signed.stderr).toBe(0);
      expect(signed.stdout).toMatch(/Verified: 2 files, 2 signatures/);
      const sums = readFileSync(join(dir, "release", "SHA256SUMS"), "utf8");
      expect(sums.trim().split("\n").map((l) => l.split("  ")[1])).toEqual(["dist/assets/app.js", "dist/index.html"]);
      expect(readFileSync(join(dir, "release", "SHA256SUMS.minisig"), "utf8")).toMatch(/^untrusted comment: .+\nRU[A-Za-z0-9+/]{97}=\ntrusted comment: lumen-md \S+ commit:\S+ file:SHA256SUMS timestamp:1794268800\n/);
      const sbom = JSON.parse(readFileSync(join(dir, "release", "sbom.cdx.json"), "utf8")) as { bomFormat: string; specVersion: string; components: Array<{ purl: string }> };
      expect(sbom.bomFormat).toBe("CycloneDX");
      expect(sbom.specVersion).toBe("1.5");
      expect(sbom.components.some((c) => c.purl.startsWith("pkg:npm/react@"))).toBe(true);
      expect(sbom.components.some((c) => c.purl.startsWith("pkg:cargo/tauri@"))).toBe(true);

      const verify = (...extra: string[]) => run(dir, [script("verify-release.mjs"), "release", ...extra]);
      expect(verify().status).toBe(0);

      appendFileSync(join(dir, "dist", "assets", "app.js"), ";");
      expect(verify().stdout).toMatch(/dist\/assets\/app\.js does not match SHA256SUMS/);
      writeFileSync(join(dir, "dist", "assets", "app.js"), "console.log('שלום')");
      expect(verify().status).toBe(0);

      writeFileSync(join(dir, "release", "SHA256SUMS"), sums.replace(/^./, (c) => (c === "0" ? "1" : "0")));
      expect(verify().stdout).toMatch(/SHA256SUMS: The signature does not match the file/);
      writeFileSync(join(dir, "release", "SHA256SUMS"), sums);

      const other = join(dir, "other");
      run(dir, [script("keys.mjs"), "--out", other], env);
      const r = verify("--pub", join(other, "lumen-release.pub"));
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/Signed with key [0-9A-F]{16}, not [0-9A-F]{16}/);

      expect(run(dir, [script("release.mjs"), "--key", join(keys, "lumen-release.key")], { ...env, LUMEN_RELEASE_PASSPHRASE: "wrong" }).stderr).toMatch(/wrong or missing LUMEN_RELEASE_PASSPHRASE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("the SBOM is reproducible: the same lockfiles and SOURCE_DATE_EPOCH give the same bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-sbom-test-"));
    try {
      const env = { SOURCE_DATE_EPOCH: "1794268800" };
      for (const n of [1, 2]) expect(run(ROOT, [script("sbom.mjs"), "--out", join(dir, `${n}.json`)], env).status).toBe(0);
      expect(readFileSync(join(dir, "1.json"), "utf8")).toBe(readFileSync(join(dir, "2.json"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
