/**
 * Plan W4.27: dist/ against Cloudflare Pages' Free-plan limits
 * (scripts/lib/pagesLimits.mjs), the second host's pre-deploy check.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs script, no types
import { headerRuleCount, LIMITS, pagesProblems, redirectRuleCount, runtimeOf } from "../../scripts/lib/pagesLimits.mjs";

const MiB = 1024 * 1024;

describe("Cloudflare Pages limits", () => {
  it("a small build fits", () => {
    const r = pagesProblems([{ path: "index.html", bytes: 2000 }, { path: "assets/app.js", bytes: 400_000 }], "/*\n  X-Frame-Options: DENY\n", "");
    expect(r.problems).toEqual([]);
    expect(r.totalBytes).toBe(402_000);
  });
  it("names every file over 25 MiB, largest first, and keeps a file of exactly 25 MiB", () => {
    const r = pagesProblems(
      [
        { path: "ort/a.wasm", bytes: 26 * MiB },
        { path: "ruby/ruby+stdlib.wasm", bytes: 30.6 * MiB },
        { path: "pyodide/pyodide.asm.wasm", bytes: 25 * MiB },
      ],
      "",
      "",
    );
    expect(r.oversize.map((f: { path: string }) => f.path)).toEqual(["ruby/ruby+stdlib.wasm", "ort/a.wasm"]);
    expect(r.problems[0]).toMatch(/^ruby\/ruby\+stdlib\.wasm is 30\.6 MiB/);
  });
  it("counts files, _headers rules and _redirects rules", () => {
    const many = Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ path: `f${i}`, bytes: 1 }));
    expect(pagesProblems(many, "", "").problems[0]).toMatch(/20001 files/);
    expect(headerRuleCount("# c\n/*\n  A: b\n\n/x.html\n  ! A\n")).toBe(2);
    expect(redirectRuleCount("# c\n/a /b 301\n\n/* /index.html 200\n")).toBe(2);
    const rules = Array.from({ length: 101 }, (_, i) => `/p${i}\n  A: b`).join("\n");
    expect(pagesProblems([], rules, "").problems).toEqual(["_headers has 101 rules: the limit is 100"]);
  });
  it("the repository's _headers fits the 100-rule limit", () => {
    const n = headerRuleCount(readFileSync(join(__dirname, "../../public/_headers"), "utf8"));
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(LIMITS.headerRules);
  });
  it("says which feature a dropped file belongs to", () => {
    expect(runtimeOf("ruby/ruby+stdlib.wasm")).toMatch(/live-ruby/);
    expect(runtimeOf("assets/x.js")).toBeNull();
  });
});
