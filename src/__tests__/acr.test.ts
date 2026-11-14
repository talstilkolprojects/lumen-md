/**
 * W3.8 — the accessibility conformance report: every WCAG 2.2 A and AA
 * criterion has a status, none at level A is unsupported, every partial one
 * has a plan, the evidence exists, the report is for this version, and the
 * docs pages are the ones scripts/acr.mjs writes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

async function acr() {
  return (await import("../../scripts/acr.mjs" as string)) as {
    WCAG22: { A: string[]; AA: string[] };
    PAGES: Record<"en" | "he", string>;
    loadReport(root?: string): { version: string; criteria: Array<{ id: string; level: string; status: string; plan?: unknown }> };
    checkReport(report: unknown, root?: string): string[];
    summary(report: unknown): Record<"A" | "AA", Record<string, number>>;
    renderPage(report: unknown, lang: "en" | "he"): string;
  };
}

describe("the ACR (WCAG 2.2)", () => {
  it("lists all 55 A and AA criteria", async () => {
    const m = await acr();
    expect(m.WCAG22.A.length).toBe(31);
    expect(m.WCAG22.AA.length).toBe(24);
    expect(m.loadReport(ROOT).criteria.length).toBe(55);
  });

  it("passes its own checks: a status for each, 0 unsupported at A, a plan for each partial, real evidence, this version", async () => {
    const m = await acr();
    expect(m.checkReport(m.loadReport(ROOT), ROOT)).toEqual([]);
    const s = m.summary(m.loadReport(ROOT));
    expect(s.A["does-not-support"]).toBe(0);
  });

  it("rejects a report that breaks the rules", async () => {
    const m = await acr();
    const good = m.loadReport(ROOT);
    const bad = JSON.parse(JSON.stringify(good));
    bad.criteria = bad.criteria.filter((c: { id: string }) => c.id !== "2.4.7");
    const a = bad.criteria.find((c: { id: string }) => c.id === "2.1.1");
    a.status = "does-not-support";
    const p = bad.criteria.find((c: { id: string }) => c.id === "1.4.12");
    delete p.plan;
    bad.criteria.find((c: { id: string }) => c.id === "1.3.1").evidence = ["e2e/nope.spec.ts"];
    bad.version = "9.9.9";
    const problems = m.checkReport(bad, ROOT).join("\n");
    expect(problems).toMatch(/2\.4\.7 \(AA\) has no entry/);
    expect(problems).toMatch(/2\.1\.1: a level A criterion is "does not support"/);
    expect(problems).toMatch(/1\.4\.12: partially-supports needs a plan/);
    expect(problems).toMatch(/evidence e2e\/nope\.spec\.ts does not exist/);
    expect(problems).toMatch(/9\.9\.9/);
  });

  it("publishes in English and Hebrew, generated from the source", async () => {
    const m = await acr();
    const report = m.loadReport(ROOT);
    for (const lang of ["en", "he"] as const) {
      const page = readFileSync(join(ROOT, m.PAGES[lang]), "utf8");
      expect(page).toBe(m.renderPage(report, lang));
      for (const id of [...m.WCAG22.A, ...m.WCAG22.AA]) expect(page).toContain(`[${id} `);
      expect(page).toContain("issues/new?template=accessibility.yml");
    }
    expect(readFileSync(join(ROOT, m.PAGES.he), "utf8")).toMatch(/נתמך חלקית/);
  });

  it("has an accessibility contact: the issue form and a palette command", () => {
    const form = readFileSync(join(ROOT, ".github/ISSUE_TEMPLATE/accessibility.yml"), "utf8");
    expect(form).toMatch(/labels: \["accessibility"\]/);
    const cmds = readFileSync(join(ROOT, "src/commands/domains/a11y.ts"), "utf8");
    expect(cmds).toMatch(/help\.a11yReport/);
    expect(cmds).toMatch(/template=accessibility\.yml/);
  });
});
