// @vitest-environment node
/**
 * Plan 2.8 — the dependency audit gate (scripts/audit-gate.mjs): exceptions
 * are time-limited (at most 90 days out), and what counts as high for npm
 * and for cargo.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_IGNORE_DAYS,
  checkIgnores,
  npmFindings,
  cargoFindings,
  cvss3Score,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/audit-gate.mjs";

const today = "2026-10-18";
const at = { dir: ".", ecosystem: "npm", today };
const entry = (over: Record<string, string> = {}) => ({ id: "GHSA-abcd-efgh-ijkl", reason: "no fix upstream yet", expires: "2026-12-01", ...over });

describe("checkIgnores", () => {
  it("keeps a valid exception for its directory and ecosystem", () => {
    const { active, errors } = checkIgnores([entry()], at);
    expect(errors).toEqual([]);
    expect([...active.keys()]).toEqual(["GHSA-abcd-efgh-ijkl"]);
  });

  it(`allows an expiry exactly ${MAX_IGNORE_DAYS} days out and refuses one a day later`, () => {
    expect(checkIgnores([entry({ expires: "2027-01-16" })], at).errors).toEqual([]);
    const { active, errors } = checkIgnores([entry({ expires: "2027-01-17" })], at);
    expect(active.size).toBe(0);
    expect(errors[0]).toMatch(/more than 90 days out \(latest allowed: 2027-01-16\)/);
  });

  it("refuses a far-off expiry even for another directory", () => {
    expect(checkIgnores([entry({ expires: "2099-01-01", dir: "docs" })], at).errors).toHaveLength(1);
  });

  it("fails an expired exception", () => {
    const { active, errors } = checkIgnores([entry({ expires: "2026-10-17" })], at);
    expect(active.size).toBe(0);
    expect(errors[0]).toMatch(/expired on 2026-10-17/);
  });

  it("fails a malformed entry", () => {
    const bads: Record<string, string>[] = [{ id: "CVE-2026-1" }, { reason: "" }, { expires: "soon" }, { expires: "2026-13-45" }];
    for (const bad of bads) {
      expect(checkIgnores([entry(bad)], at).errors).toHaveLength(1);
    }
  });

  it("applies an exception only to its own directory and ecosystem", () => {
    expect(checkIgnores([entry({ dir: "docs" })], at).active.size).toBe(0);
    const rust = { id: "RUSTSEC-2026-0001", reason: "r", expires: "2026-11-01", dir: "src-tauri" };
    expect(checkIgnores([rust], at).active.size).toBe(0);
    expect(checkIgnores([rust], { dir: "src-tauri", ecosystem: "cargo", today }).active.size).toBe(1);
  });
});

describe("npmFindings", () => {
  it("returns high and critical advisories by GHSA id, not moderate ones", () => {
    const report = {
      vulnerabilities: {
        lodash: { range: "<=4.17.23", fixAvailable: true, via: [{ severity: "high", url: "https://github.com/advisories/GHSA-p6mc-m468-83gw", title: "Prototype Pollution" }] },
        esbuild: { range: "0.27.3", fixAvailable: true, via: [{ severity: "moderate", url: "https://github.com/advisories/GHSA-g7r4-m6w7-qqqr", title: "x" }] },
        dep: { range: "*", fixAvailable: true, via: ["lodash"] },
      },
    };
    expect(npmFindings(report).map((f: { id: string }) => f.id)).toEqual(["GHSA-p6mc-m468-83gw"]);
  });
});

describe("cargo", () => {
  it("scores CVSS v3 vectors like the spec", () => {
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")).toBe(10);
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(7.5);
    expect(cvss3Score("CVSS:3.1/AV:L/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N")).toBe(2.2);
    expect(cvss3Score(null)).toBeNull();
    expect(cvss3Score("CVSS:4.0/AV:N")).toBeNull();
  });

  it("counts CVSS >= 7 and unscored advisories, not low-scored ones", () => {
    const vuln = (id: string, cvss: string | null) => ({ advisory: { id, cvss, title: id }, package: { name: "p", version: "1.0.0" }, versions: { patched: [">=1.0.1"] } });
    const report = {
      vulnerabilities: {
        list: [
          vuln("RUSTSEC-2026-0001", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"),
          vuln("RUSTSEC-2026-0002", "CVSS:3.1/AV:L/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N"),
          vuln("RUSTSEC-2026-0003", null),
        ],
      },
    };
    expect(cargoFindings(report).map((f: { id: string }) => f.id)).toEqual(["RUSTSEC-2026-0001", "RUSTSEC-2026-0003"]);
  });
});
