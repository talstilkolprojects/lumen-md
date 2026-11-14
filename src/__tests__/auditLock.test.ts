// @vitest-environment node
/**
 * Plan 2.8 / 12.2 — the offline known-bad versions gate
 * (scripts/audit-lock.mjs, security/known-bad.json): range matching,
 * lockfile and manifest parsing, fixed entries that regress, and open
 * entries that expire or go stale. The last test runs it on the repo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_OPEN_DAYS,
  compareVersions,
  inRange,
  rangeFloor,
  npmLockVersions,
  cargoLockVersions,
  manifestVersions,
  readVersions,
  check,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/audit-lock.mjs";

type Pkg = { name: string; version: string; where: string };
const today = "2026-11-12";
const lock = (pkgs: Record<string, string>) => ({
  lockfileVersion: 3,
  packages: { "": { name: "x" }, ...Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [k, { version: v }])) },
});
const files = (map: Record<string, Pkg[]>) => (f: string) => map[f] ?? null;
const pkg = (name: string, version: string): Pkg => ({ name, version, where: name });

describe("versions and ranges", () => {
  it("orders versions numerically, a prerelease before its release", () => {
    expect(compareVersions("3.3.20", "3.3.3")).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("4.18.1", "4.18.1")).toBe(0);
  });

  it("matches the nanoid range on both lines and not the patched copies", () => {
    const r = "<3.3.16 || >=4.0.0 <5.1.16";
    expect(inRange("3.3.3", r)).toBe(true);
    expect(inRange("4.0.2", r)).toBe(true);
    expect(inRange("5.1.15", r)).toBe(true);
    expect(inRange("3.3.20", r)).toBe(false);
    expect(inRange("5.1.16", r)).toBe(false);
  });

  it("supports <=, >, = and a bare version", () => {
    expect(inRange("2.3.0", "<=2.3.0")).toBe(true);
    expect(inRange("2.3.1", ">2.3.0")).toBe(true);
    expect(inRange("2.3.0", "=2.3.0")).toBe(true);
    expect(inRange("2.3.0", "2.3.0")).toBe(true);
    expect(inRange("2.3.1", "2.3.0")).toBe(false);
  });

  it("refuses a comparator it can't read", () => {
    expect(() => inRange("1.0.0", "^1.0.0")).toThrow(/bad comparator/);
  });

  it("takes the floor of a package.json range", () => {
    expect(rangeFloor("^5.0.0")).toBe("5.0.0");
    expect(rangeFloor("~8.3")).toBe("8.3.0");
    expect(rangeFloor(">=18")).toBe("18.0.0");
    expect(rangeFloor("^3.25 || ^4.0")).toBe("3.25.0");
    expect(rangeFloor("workspace:*")).toBeNull();
  });
});

describe("parsing", () => {
  it("reads every installed copy of an npm lockfile, nested ones too", () => {
    const got = npmLockVersions(lock({ "node_modules/nanoid": "5.1.16", "node_modules/a/node_modules/nanoid": "3.3.3", "node_modules/@s/b": "1.0.0" }));
    expect(got.map((p: Pkg) => `${p.name}@${p.version}`)).toEqual(["nanoid@5.1.16", "nanoid@3.3.3", "@s/b@1.0.0"]);
  });

  it("reads a Cargo.lock", () => {
    const text = `version = 4\n\n[[package]]\nname = "zip"\nversion = "4.6.1"\nsource = "registry"\n\n[[package]]\nname = "glib"\nversion = "0.18.5"\n`;
    expect(cargoLockVersions(text).map((p: Pkg) => `${p.name}@${p.version}`)).toEqual(["zip@4.6.1", "glib@0.18.5"]);
  });

  it("reads the floors of a package.json's ranges", () => {
    const got = manifestVersions({ devDependencies: { vite: "^5.0.0" }, peerDependencies: { react: ">=18" } });
    expect(got.map((p: Pkg) => `${p.name}@${p.version}`)).toEqual(["vite@5.0.0", "react@18.0.0"]);
  });
});

describe("check", () => {
  const fixed = { file: "package-lock.json", name: "nanoid", range: "<3.3.16", advisories: ["GHSA-x"], status: "fixed" };
  const open = { file: "Cargo.lock", name: "zip", versions: ["4.6.1"], advisories: ["GHSA-y"], status: "open", fix: "cargo update", expires: "2026-12-01" };

  it("passes a fixed entry whose bad versions are gone", () => {
    expect(check([fixed], files({ "package-lock.json": [pkg("nanoid", "3.3.20")] }), today)).toEqual({ errors: [], open: [] });
  });

  it("fails a fixed entry when a bad version comes back", () => {
    const { errors } = check([fixed], files({ "package-lock.json": [pkg("nanoid", "3.3.3")] }), today);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/nanoid is back at a known-bad version: 3\.3\.3/);
  });

  it("reports an open entry until it expires, then fails it", () => {
    const m = files({ "Cargo.lock": [pkg("zip", "4.6.1")] });
    const before = check([open], m, today);
    expect(before.errors).toEqual([]);
    expect(before.open[0]).toMatch(/zip 4\.6\.1 .* until 2026-12-01; owner: cargo update/);
    const after = check([open], m, "2026-12-02");
    expect(after.errors[0]).toMatch(/expired on 2026-12-01.*run: cargo update/);
  });

  it("fails a stale open entry once the bad version is gone", () => {
    const { errors } = check([open], files({ "Cargo.lock": [pkg("zip", "9.1.0")] }), today);
    expect(errors[0]).toMatch(/no longer matches anything.*"fixed"/);
  });

  it(`refuses an open entry more than ${MAX_OPEN_DAYS} days out, or without a fix`, () => {
    const m = files({ "Cargo.lock": [pkg("zip", "4.6.1")] });
    expect(check([{ ...open, expires: "2027-02-10" }], m, today).errors).toEqual([]);
    expect(check([{ ...open, expires: "2027-02-11" }], m, today).errors[0]).toMatch(/more than 90 days out \(latest allowed: 2027-02-10\)/);
    expect(check([{ ...open, fix: "" }], m, today).errors[0]).toMatch(/needs fix/);
  });

  it("refuses a malformed entry and a missing file", () => {
    expect(check([{ ...fixed, versions: ["1.0.0"] }], files({}), today).errors[0]).toMatch(/exactly one of range \/ versions/);
    expect(check([fixed], files({}), today).errors[0]).toMatch(/does not exist/);
  });
});

describe("the repo", () => {
  it("has no fixed entry back at a known-bad version", () => {
    const root = process.cwd();
    const { entries } = JSON.parse(readFileSync(join(root, "security/known-bad.json"), "utf8"));
    const versionsOf = (f: string) => (existsSync(join(root, f)) ? readVersions(root, f) : null);
    const { errors } = check(entries, versionsOf, new Date().toISOString().slice(0, 10));
    expect(errors).toEqual([]);
  });
});

describe("W10.D9: the critical zip advisory and the updater", () => {
  const root = process.cwd();
  const { entries } = JSON.parse(readFileSync(join(root, "security/known-bad.json"), "utf8"));
  const lock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  // verify/train-4's Cargo.lock (fcf760fde8): tauri-plugin-updater 2.14.0, zip 4.6.1. The two blocks as they were.
  const oldLock = `[[package]]\nname = "tauri-plugin-updater"\nversion = "2.14.0"\n\n[[package]]\nname = "zip"\nversion = "4.6.1"\n`;
  const withOld = (f: string) => (f === "src-tauri/Cargo.lock" ? cargoLockVersions(oldLock) : existsSync(join(root, f)) ? readVersions(root, f) : null);

  it("a critical or high entry can't wait behind an open exception", () => {
    const crit = { file: "Cargo.lock", name: "zip", versions: ["4.6.1"], advisories: ["GHSA-y"], status: "open", severity: "critical", fix: "cargo update", expires: "2026-12-01" };
    const m = (f: string) => (f === "Cargo.lock" ? cargoLockVersions(oldLock) : null);
    expect(check([crit], m, today).errors[0]).toMatch(/zip: critical GHSA-y can't stay open \(still at 4\.6\.1\); run: cargo update/);
    expect(check([{ ...crit, severity: "high" }], m, today).errors).toHaveLength(1);
    expect(check([{ ...crit, severity: "moderate" }], m, today).errors).toEqual([]);
  });

  it("is red on train-4's lock (zip 4.6.1, updater 2.14.0)", () => {
    const { errors } = check(entries, withOld, today);
    expect(errors.some((e: string) => /zip is back at a known-bad version: 4\.6\.1/.test(e))).toBe(true);
    expect(errors.some((e: string) => /tauri-plugin-updater is back at a known-bad version: 2\.14\.0/.test(e))).toBe(true);
  });

  it("is green on this lock: zip ≥ 9.1.0 through tauri-plugin-updater ≥ 2.14.1, which Cargo.toml requires", () => {
    const v = Object.fromEntries(cargoLockVersions(lock).map((p: Pkg) => [p.name, p.version]));
    expect(compareVersions(v.zip, "9.1.0")).toBeGreaterThanOrEqual(0);
    expect(compareVersions(v["tauri-plugin-updater"], "2.14.1")).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8")).toMatch(/^tauri-plugin-updater = "2\.14\.1"$/m);
    const zip = entries.find((e: { name: string }) => e.name === "zip");
    expect(zip).toMatchObject({ status: "fixed", severity: "critical", range: "<9.1.0" });
  });
});
