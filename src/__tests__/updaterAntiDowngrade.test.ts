/**
 * W10.D9 (research R3.2, CVE-2026-95624/95625): the desktop updater can't be
 * talked into a downgrade. The manifest is unsigned, so the Rust side refuses
 * any release that isn't newer than the running build and than the highest
 * version ever installed (src-tauri/src/update_guard.rs, tested with
 * `rustc --test`); the plugin config pins allowDowngrades off and binds the
 * version to the signature; the webview holds no updater permission, so only
 * the app's two commands reach the updater.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(f, "utf8");

describe("desktop updater: no downgrade", () => {
  it("the plugin config forbids downgrades and binds the version to the signature", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.plugins.updater.allowDowngrades).toBe(false);
    expect(conf.plugins.updater.requireSignedVersion).toBe(true);
  });

  it("the webview's capabilities grant no updater permission", () => {
    const cap = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(cap.permissions.filter((p: unknown) => String(typeof p === "string" ? p : (p as { identifier?: string }).identifier).startsWith("updater:"))).toEqual([]);
  });

  it("every update check goes through the anti-downgrade comparator", () => {
    const rs = read("src-tauri/src/updates.rs");
    expect(rs).toMatch(/\.version_comparator\(move \|current, remote\| update_guard::accept\(/);
    expect(rs.match(/updater_builder\(\)/g)).toHaveLength(1); // the only builder is the guarded one
    expect(read("src-tauri/src/lib.rs")).toMatch(/^mod update_guard;$/m);
    const guard = read("src-tauri/src/update_guard.rs");
    expect(guard).not.toMatch(/^use (?!std)/m); // no dependencies: rustc --test runs it alone
  });

  it("requires tauri-plugin-updater 2.14.1 (zip 9, canonical-S minisign)", () => {
    expect(read("src-tauri/Cargo.toml")).toMatch(/^tauri-plugin-updater = "2\.14\.1"$/m);
  });
});
