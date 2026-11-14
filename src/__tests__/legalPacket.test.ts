/**
 * Plan W6.37: the free legal-review packet — every document it lists exists,
 * the cover note asks the questions the plan names, and the data-licence list
 * is generated from the model registry and the data folders, not by hand.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain .mjs script, no types
import { DOCS, dataLicences } from "../../scripts/legal-packet.mjs";

const ROOT = resolve(__dirname, "../..");

describe("legal review packet (W6.37)", () => {
  it("lists only documents that exist, the privacy policy, Sefaria and the licences among them", () => {
    const paths = (DOCS as [string, string, string][]).map((d) => d[0]);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
    for (const p of ["PRIVACY.he.md", "src/sources/sefaria/license.ts", "models/registry.json", "legal/review-packet/recommendations.md"]) expect(paths).toContain(p);
    expect(execFileSync(process.execPath, [join(ROOT, "scripts/legal-packet.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" })).toMatch(/✓ legal packet/);
  });

  it("the data-licence list has every registry model and the Sefaria rule", () => {
    const reg = JSON.parse(readFileSync(join(ROOT, "models/registry.json"), "utf8")) as { models: { id: string; license: string }[] };
    const text = dataLicences(ROOT) as string;
    for (const m of reg.models) expect(text, m.id).toContain(`| ${m.id.replace(/\|/g, "\\|")} |`);
    expect(text).toMatch(/CC-BY-NC\*.*link only/);
    expect(text).toContain("eval/golden/asr-he");
  });

  it("the Hebrew cover note asks about Amendment 13, the impact assessment, Sefaria and speech data", () => {
    const he = readFileSync(join(ROOT, "legal/review-packet/README.he.md"), "utf8");
    for (const w of ["תיקון 13", "הערכת ההשפעה", "Sefaria", "ivrit.ai", "PrivacyLaw@tauex.tau.ac.il"]) expect(he).toContain(w);
  });
});
