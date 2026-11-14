// @vitest-environment node
/**
 * W4.2 — Playwright specs reach the app's modules through
 * window.__lumenTest (src/testing/e2eHooks.ts), never `import("/src/…")`,
 * which only the dev server answers: the e2e gate serves the production
 * build. The hook is in dev and in VITE_E2E=1 builds, never in production.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installE2eHooks, type LumenTestHooks } from "../testing/e2eHooks";
// @ts-expect-error — plain .mjs script without type declarations
import { PRODUCTION_GATES, PREVIEW_GATES } from "../../scripts/vercel-build.mjs";

const ROOT = resolve(__dirname, "..", "..");
const specs = readdirSync(join(ROOT, "e2e"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ f, text: readFileSync(join(ROOT, "e2e", f), "utf8") }));

describe("e2e test hooks", () => {
  it("no spec imports the app's sources inside the page", () => {
    const offenders = specs.filter(({ text }) => /import\(\s*(\/\*[^*]*\*\/\s*)?["'`]\/src\//.test(text)).map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it("every module a spec loads is one the hook knows", () => {
    const target: { __lumenTest?: LumenTestHooks } = {};
    installE2eHooks(target);
    const known = new Set(target.__lumenTest!.modules);
    const used = new Set(specs.flatMap(({ text }) => [...text.matchAll(/__lumenTest\.load\("([^"]+)"\)/g)].map((m) => m[1])));
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((n) => !known.has(n))).toEqual([]);
  });

  it("is installed on the dev server and in VITE_E2E=1 builds only", () => {
    const main = readFileSync(join(ROOT, "src/main.tsx"), "utf8");
    expect(main).toMatch(/if \(import\.meta\.env\.DEV \|\| __LUMEN_E2E__\) void import\("\.\/testing\/e2eHooks"\)/);
    const vite = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    expect(vite).toContain('__LUMEN_E2E__: JSON.stringify(process.env.VITE_E2E === "1")');
    // vercel-build sets VITE_E2E for a build whose gates include e2e: previews, not production.
    expect(PREVIEW_GATES).toContain("e2e");
    expect(PRODUCTION_GATES).not.toContain("e2e");
    expect(readFileSync(join(ROOT, "scripts/vercel-build.mjs"), "utf8")).toMatch(/if \(gates\.includes\("e2e"\)\) \{?\s*process\.env\.VITE_E2E \?\?= "1";/);
  });
});
