// @vitest-environment node
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import { promotionVerdict, safariKind, safariPlatforms, verdictLines } from "../../scripts/promote/lib.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { SAFARI_PLATFORMS, SAFARI_SPECS, browserstackYml, platformOf, resultsByPlatform, safariSuites } from "../../scripts/safari/lib.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const good: { ok: boolean; problems: string[] } = { ok: true, problems: [] };
type Suites = Record<string, { ok: boolean; detail: string }>;
const full = (sha: string, suites: Suites, verified = good, path = `commits/${sha}/full-1.json`) => ({ path, verified, report: { kind: "full", commit: { sha }, suites } });
const pass = (detail = "300 passed, 0 failed, 0 flaky") => ({ ok: true, detail });
const fail = (detail = "1 failed") => ({ ok: false, detail });
const safariAll: Suites = { "safari ios 26 (iPhone 17)": pass(), "safari ios 17 (iPhone 15)": pass(), "safari macos sequoia (playwright-webkit)": pass() };

describe("promote:check (plan W6.6)", () => {
  it("passes only with WebKit and Safari (iOS and macOS) on the same commit", () => {
    expect(promotionVerdict(A, [full(A, { "e2e webkit": pass(), ...safariAll })]).ok).toBe(true);
    const noSafari = promotionVerdict(A, [full(A, { "e2e webkit": pass() })]);
    expect(noSafari).toMatchObject({ ok: false, webkit: { ok: true }, safari: { ok: false } });
    expect(noSafari.safari.why).toEqual(["no Safari iOS (real device) run", "no Safari macOS run"]);
    const noWebkit = promotionVerdict(A, [full(A, { "e2e chromium": pass(), ...safariAll })]);
    expect(noWebkit.webkit.why).toEqual([`commits/${A}/full-1.json: WebKit did not run`]);
  });

  it("refuses a failed WebKit run, a failed drill, and a failed Safari platform", () => {
    expect(promotionVerdict(A, [full(A, { "e2e webkit": fail(), ...safariAll })]).webkit.why[0]).toMatch(/WebKit failed \(1 failed\)/);
    expect(promotionVerdict(A, [full(A, { "e2e webkit": pass(), "drill-data-safety": fail("exit 1"), ...safariAll })]).webkit.why[0]).toMatch(/data-safety drill failed/);
    const v = promotionVerdict(A, [full(A, { "e2e webkit": pass(), ...safariAll, "safari ios 18 (iPhone 16)": fail() })]);
    expect(v.safari.ok).toBe(false);
    expect(v.safari.why).toEqual(["failed: safari ios 18 (iPhone 16)"]);
  });

  it("a receipt of another commit counts only when the trees are equal; an unverified one never", () => {
    const r = [full(B, { "e2e webkit": pass(), ...safariAll })];
    expect(promotionVerdict(A, r).ok).toBe(false);
    expect(promotionVerdict(A, r).webkit.why[0]).toMatch(/no receipt for aaaaaaaaa/);
    expect(promotionVerdict(A, r, (x: string, y: string) => [x, y].sort().join() === [A, B].sort().join()).ok).toBe(true);
    const forged = promotionVerdict(A, [full(A, { "e2e webkit": pass(), ...safariAll }, { ok: false, problems: ["the signature does not verify"] })]);
    expect(forged.ok).toBe(false);
    expect(forged.webkit.why[0]).toMatch(/not counted, the signature does not verify/);
  });

  it("WebKit and Safari may come from two receipts of the commit; a later pass of a platform replaces an earlier failure", () => {
    const safariReceipt = {
      path: "commits/a/safari-1.json",
      verified: good,
      report: { kind: "safari", commit: { sha: A }, platforms: [{ name: "safari ios 18 (iPhone 16)", os: "ios", ok: true }, { name: "safari macos sequoia (playwright-webkit)", os: "macos", ok: true }] },
    };
    const earlier = full(A, { "e2e webkit": pass(), "safari ios 18 (iPhone 16)": fail() }, good, "commits/a/full-0.json");
    const v = promotionVerdict(A, [earlier, safariReceipt]);
    expect(v.ok).toBe(true);
    expect(v.safari.platforms.find((p: { name: string }) => p.name === "safari ios 18 (iPhone 16)")).toMatchObject({ ok: true, by: "commits/a/safari-1.json" });
    expect(verdictLines(A, v).at(-1)).toMatch(/^✓ promote:check/);
    expect(verdictLines(A, promotionVerdict(A, [])).at(-1)).toMatch(/^✗ promote:check: refused/);
  });

  it("names Safari platforms by kind", () => {
    expect(["safari ios 17 (iPhone 15)", "safari macos sequoia", "safari mac", "e2e webkit"].map(safariKind)).toEqual(["ios", "macos", "macos", null]);
    expect(safariPlatforms({ kind: "full", suites: { "e2e webkit": pass(), "safari ios 26 (iPhone 17)": pass() } })).toEqual([{ kind: "ios", name: "safari ios 26 (iPhone 17)", ok: true }]);
  });
});

describe("Safari on BrowserStack (plan W6.6)", () => {
  it("covers real iOS devices before Safari 26 and macOS, and the specs of the 15.12 check", () => {
    expect(SAFARI_PLATFORMS.filter((p: { os: string }) => p.os === "ios").map((p: { osVersion: string }) => p.osVersion)).toEqual(["26", "18", "17"]);
    expect(SAFARI_PLATFORMS.some((p: { os: string }) => p.os === "macos")).toBe(true);
    expect(SAFARI_SPECS).toContain("e2e/data-safety.spec.ts");
    expect(SAFARI_SPECS).toContain("e2e/rtl.spec.ts");
  });

  it("writes the SDK's browserstack.yml with Local on and no credentials", () => {
    const yml = browserstackYml({ build: "lumen-md abc" });
    expect(yml).toContain("browserstackLocal: true");
    expect(yml).toContain('  - deviceName: "iPhone 15"\n    osVersion: "17"\n    browserName: "safari"');
    expect(yml).toContain('  - os: "OS X"\n    osVersion: "Sequoia"\n    browserName: "playwright-webkit"');
    expect(yml).not.toMatch(/accessKey|userName/);
  });

  it("maps the SDK's projects back to platforms; a platform without tests did not run", () => {
    expect(platformOf("iPhone 15 17 safari")?.name).toBe("safari ios 17 (iPhone 15)");
    expect(platformOf("OS X Sequoia playwright-webkit")?.os).toBe("macos");
    expect(platformOf("chromium")).toBeNull();
    const report = {
      suites: [
        {
          file: "smoke.spec.ts",
          specs: [
            { title: "opens", file: "smoke.spec.ts", tests: [{ projectName: "iPhone 17 26 safari", status: "expected" }, { projectName: "iPhone 15 17 safari", status: "unexpected" }] },
            { title: "types", file: "smoke.spec.ts", tests: [{ projectName: "iPhone 15 17 safari", status: "flaky" }] },
          ],
        },
      ],
    };
    const r = resultsByPlatform(report);
    expect(r.map((x: { name: string; ok: boolean; ran: boolean }) => [x.name, x.ok, x.ran])).toEqual([
      ["safari ios 26 (iPhone 17)", true, true],
      ["safari ios 18 (iPhone 16)", false, false],
      ["safari ios 17 (iPhone 15)", false, true],
      ["safari macos sequoia (playwright-webkit)", false, false],
    ]);
    expect(r[2].failedTests).toEqual(["smoke.spec.ts › opens"]);
    expect(safariSuites(r)["safari ios 18 (iPhone 16)"]).toEqual({ ok: false, detail: "did not run" });
    expect(resultsByPlatform(null).every((x: { ok: boolean }) => !x.ok)).toBe(true);
  });
});
