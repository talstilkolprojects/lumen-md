/**
 * Pagefind on the docs build (plan W4.34): the fallback runs the release
 * binary of the same version as the docs' lockfile, for every platform it
 * is published for, with the release's own checksum pinned.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs modules without types
import { ASSETS, PAGEFIND_VERSION, indexed, releaseAsset } from "../../scripts/docs-pagefind.mjs";

const ROOT = resolve(__dirname, "../..");

describe("docs Pagefind", () => {
  it("uses the Pagefind version the docs site locks", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "docs/package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/pagefind"]?.version).toBe(PAGEFIND_VERSION);
  });

  it("knows the release asset and its SHA-256 for Linux, macOS and Windows", () => {
    expect(releaseAsset("linux", "x64")).toEqual({
      file: `pagefind-v${PAGEFIND_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
      url: `https://github.com/CloudCannon/pagefind/releases/download/v${PAGEFIND_VERSION}/pagefind-v${PAGEFIND_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
      sha256: "afb824a9e7f64905a934900481cea5be679c03975e527329e0e5e6cc70f5feda",
      exe: "pagefind",
    });
    expect(releaseAsset("darwin", "arm64")?.file).toContain("aarch64-apple-darwin");
    expect(releaseAsset("win32", "x64")?.exe).toBe("pagefind.exe");
    expect(releaseAsset("freebsd", "x64")).toBeNull();
    for (const a of Object.values(ASSETS)) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sees whether the site is already indexed", () => {
    const site = mkdtempSync(join(tmpdir(), "docs-site-"));
    expect(indexed(site)).toBe(false);
    mkdirSync(join(site, "pagefind"));
    writeFileSync(join(site, "pagefind", "pagefind.js"), "");
    writeFileSync(join(site, "pagefind", "pagefind-entry.json"), "{}");
    expect(indexed(site)).toBe(true);
  });
});
