/** Plan 11.5 — desktop release: no source maps, fs permissions narrowed, optional signing, updater manifest. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import { findSourceMaps } from "../../scripts/lib/sourcemaps.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { latestJson, platformOf, withUpdater, withWindowsThumbprint } from "../../scripts/lib/tauriSigning.mjs";

const root = join(__dirname, "..", "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));

describe("no source maps (11.5.3)", () => {
  it("the production build config turns them off (app and service worker)", () => {
    const vite = readFileSync(join(root, "vite.config.ts"), "utf8");
    expect(vite).toMatch(/sourcemap: process\.env\.LUMEN_SOURCEMAP === "1"/);
    expect(vite).not.toMatch(/sourcemap: true/);
    expect(vite).toMatch(/workbox: \{[\s\S]*?sourcemap: false/);
  });

  it("finds .map files and sourceMappingURL comments", async () => {
    const d = mkdtempSync(join(tmpdir(), "lumen-maps-"));
    mkdirSync(join(d, "assets"));
    writeFileSync(join(d, "assets/a.js"), "console.log(1)\n");
    expect(await findSourceMaps(d)).toEqual([]);
    writeFileSync(join(d, "assets/b.js"), "x()\n//# sourceMappingURL=b.js.map\n");
    writeFileSync(join(d, "assets/b.js.map"), "{}");
    writeFileSync(join(d, "c.css"), "a{}/*# sourceMappingURL=c.css.map */");
    expect(await findSourceMaps(d)).toEqual(["assets/b.js", "assets/b.js.map", "c.css"]);
  });
});

describe("narrow permissions (11.5.3)", () => {
  it("the window has no fs: permission and no shell / http plugin", () => {
    const cap = JSON.parse(readFileSync(join(root, "src-tauri/capabilities/default.json"), "utf8"));
    const perms: string[] = cap.permissions.map((p: string | { identifier: string }) => (typeof p === "string" ? p : p.identifier));
    expect(perms.filter((p) => /^(fs|shell|http|updater):/.test(p))).toEqual([]);
    const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
    const deps = cargo.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(deps).not.toMatch(/tauri-plugin-(fs|shell|http)\b/);
  });

  it("the updater is driven from Rust commands, not from the WebView", () => {
    const lib = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
    expect(lib).toMatch(/updates::imp::update_check/);
    expect(lib).toMatch(/updates::imp::update_install/);
  });
});

describe("signing is optional (11.5.2) and the updater stays off without keys (11.5.1)", () => {
  it("without secrets: no update artifacts, no endpoint, the build is not broken", () => {
    const { conf: c, updater } = withUpdater(conf, {});
    expect(updater).toBe(false);
    expect(c.bundle.createUpdaterArtifacts).toBe(false);
    expect(c.plugins.updater.endpoints).toEqual([]);
  });

  it("with the keys: signed artifacts and one endpoint, signed-version required", () => {
    const { conf: c, updater } = withUpdater(conf, { LUMEN_UPDATER_PUBKEY: "dW50cnVzdGVk", LUMEN_UPDATER_ENDPOINT: "https://github.com/o/r/releases/latest/download/latest.json", TAURI_SIGNING_PRIVATE_KEY: "k" });
    expect(updater).toBe(true);
    expect(c.plugins.updater).toMatchObject({ pubkey: "dW50cnVzdGVk", endpoints: ["https://github.com/o/r/releases/latest/download/latest.json"], requireSignedVersion: true });
    expect(conf.bundle.createUpdaterArtifacts).toBe(false); // the committed file stays inert
  });

  it("Windows signing takes a real thumbprint only", () => {
    expect(() => withWindowsThumbprint(conf, "nope")).toThrow();
    expect(withWindowsThumbprint(conf, "a".repeat(40)).bundle.windows.certificateThumbprint).toBe("A".repeat(40));
  });

  it("the release workflow skips signing steps without secrets instead of failing", () => {
    const wf = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    expect(wf).toMatch(/WINDOWS_CERTIFICATE not set — the Windows installer is NOT signed/);
    expect(wf).toMatch(/TAURI_SIGNING_PRIVATE_KEY not set/);
    expect(wf).toMatch(/check-sourcemaps\.mjs dist/);
  });
});

describe("latest.json (11.5.1)", () => {
  it("maps each signed bundle to its platform and URL", () => {
    expect(platformOf("Lumen_0.2.0_aarch64.app.tar.gz.sig")).toBe("darwin-aarch64");
    expect(platformOf("Lumen_0.2.0_amd64.AppImage.sig")).toBe("linux-x86_64");
    expect(platformOf("Lumen_0.2.0_x64-setup.exe.sig")).toBe("windows-x86_64");
    expect(platformOf("notes.txt")).toBeNull();
    const j = latestJson({
      tag: "v0.2.0",
      repo: "o/r",
      date: new Date("2026-10-24T00:00:00Z"),
      sigs: [
        { name: "Lumen_0.2.0_x64_en-US.msi.sig", signature: "msi\n" },
        { name: "Lumen_0.2.0_x64-setup.exe.sig", signature: "exe\n" },
        { name: "Lumen_0.2.0_aarch64.app.tar.gz.sig", signature: "mac" },
      ],
    });
    expect(j.version).toBe("0.2.0");
    expect(j.platforms["windows-x86_64"]).toEqual({ signature: "exe", url: "https://github.com/o/r/releases/download/v0.2.0/Lumen_0.2.0_x64-setup.exe" });
    expect(j.platforms["darwin-aarch64"].url).toBe("https://github.com/o/r/releases/download/v0.2.0/Lumen_0.2.0_aarch64.app.tar.gz");
  });
});
