/**
 * W2.25 — launch materials: the comparison (every claim sourced; the page
 * generated from it; unverified claims marked and blocking a strict check),
 * the beta page (no request of its own; e-mail only with consent and an
 * owner-set endpoint; Hebrew first), and the community files.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import { compareProblems, renderCompare } from "../../scripts/lib/launch.mjs";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const data = JSON.parse(read("launch/comparison.json"));
const docExists = (slug: string) => ["md", "mdx"].some((x) => existsSync(join(root, `docs/src/content/docs/${slug.replace(/^\/|\/$/g, "")}.${x}`)));

describe("the comparison", () => {
  it("every claim has a source; every product has a claim on every topic; Lumen's sources are real docs pages", () => {
    expect(compareProblems(data, { docExists })).toEqual([]);
    expect(data.claims.length).toBe(data.products.length * data.topics.length);
  });

  it("--strict lists exactly the claims still to verify", () => {
    const strict = compareProblems(data, { docExists, strict: true });
    const unverified = data.claims.filter((c: { verified: string | null }) => !c.verified).map((c: { product: string; topic: string }) => `${c.product}/${c.topic}: not verified yet`);
    expect(strict).toEqual(unverified);
    // Lumen's own claims are all checked against its docs.
    expect(data.claims.filter((c: { product: string; verified: string | null }) => c.product === "lumen" && !c.verified)).toEqual([]);
  });

  it("refuses a claim without a source, a non-https source, a missing docs page, superlatives, a bad date, too few gaps", () => {
    const base = structuredClone(data);
    const mk = (f: (d: typeof data) => void) => {
      const d = structuredClone(base);
      f(d);
      return compareProblems(d, { docExists }).join("\n");
    };
    expect(mk((d) => (d.claims[0].source = ""))).toMatch(/no source/);
    expect(mk((d) => (d.claims[1].source = "http://obsidian.md"))).toMatch(/https URL/);
    expect(mk((d) => (d.claims[0].source = "/no/such/page/"))).toMatch(/does not exist/);
    expect(mk((d) => (d.claims[0].en = "The best editor."))).toMatch(/superlatives/);
    expect(mk((d) => (d.claims[0].verified = "yesterday"))).toMatch(/date/);
    expect(mk((d) => (d.lumenGaps = d.lumenGaps.slice(0, 2)))).toMatch(/at least three/);
    expect(mk((d) => d.claims.pop())).toMatch(/no claim/);
  });

  it("the docs pages are generated from the JSON, in English and Hebrew, with unverified claims marked", () => {
    for (const [lang, p] of [["en", "docs/src/content/docs/project/compare.md"], ["he", "docs/src/content/docs/he/project/compare.md"]] as const) {
      const md = read(p);
      expect(md).toBe(renderCompare(data, lang));
      const unverified = data.claims.filter((c: { verified: string | null }) => !c.verified).length;
      expect(md.split(`⚠ ${lang === "he" ? "עוד לא נבדק" : "not yet verified"}`).length - 1).toBe(unverified);
      for (const g of data.lumenGaps) expect(md).toContain(g[lang]);
    }
    expect(read("docs/astro.config.mjs")).toContain('slug: "project/compare"');
  });
});

describe("the beta page", () => {
  const html = read("public/beta.html");
  const js = read("public/beta.js");

  it("loads nothing from elsewhere and has no inline script (the site CSP is script-src 'self')", () => {
    expect(html).not.toMatch(/<script(?![^>]*src="\/beta\.js")/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/@import|fonts\.googleapis/);
    expect(js).not.toMatch(/sendBeacon|XMLHttpRequest|new Image\(|navigator\.sendBeacon|document\.cookie/);
  });

  it("is Hebrew first, and every string has its English", () => {
    expect(html).toMatch(/<html lang="he" dir="rtl">/);
    const keys = [...html.matchAll(/data-i18n(?:-aria)?="([a-zA-Z0-9]+)"/g)].map((m) => m[1]);
    const en = /en: \{([\s\S]*?)\n {4}\},/.exec(js)![1];
    for (const k of new Set(keys)) expect(en, k).toMatch(new RegExp(`\\b${k}:`));
  });

  it("joining is a link to GitHub Discussions; the e-mail list is off unless the owner sets an endpoint", () => {
    expect(html).toContain('href="https://github.com/talstilkol/lumen-md/discussions/new?category=beta"');
    expect(html).toMatch(/<body data-signup-endpoint="">/);
    expect(html).toMatch(/id="email-signup" hidden/);
    // One request in the whole script, after the endpoint check, inside submit, after the consent check.
    expect(js.match(/fetch\(/g)?.length).toBe(1);
    const endpointCheck = js.indexOf('if (!/^https:\\/\\//.test(endpoint)) return;');
    const submit = js.indexOf('form.addEventListener("submit"');
    const consent = js.indexOf("if (!consent.checked) return;", submit);
    const fetchAt = js.indexOf("fetch(");
    expect(endpointCheck).toBeGreaterThan(0);
    expect(endpointCheck < submit && submit < consent && consent < fetchAt).toBe(true);
    expect(js).toMatch(/credentials: "omit"/);
    expect(js).toMatch(/JSON\.stringify\(\{ email: v, consent: true, lang: lang \}\)/);
  });
});

describe("community", () => {
  it("a Hebrew code of conduct, a community guide in both languages with a reporting section, and Discussions forms", () => {
    expect(read("CODE_OF_CONDUCT.he.md")).toMatch(/Contributor Covenant/);
    expect(read("CODE_OF_CONDUCT.md")).toContain("COMMUNITY.md#reporting");
    expect(read("CODE_OF_CONDUCT.he.md")).toContain("COMMUNITY.he.md#דיווח");
    expect(read("COMMUNITY.md")).toMatch(/^## Reporting$/m);
    expect(read("COMMUNITY.he.md")).toMatch(/^## דיווח$/m);
    // Both enforcement ladders have the same four steps.
    expect(read("CODE_OF_CONDUCT.md").match(/^\d\. \*\*/gm)?.length).toBe(4);
    expect(read("CODE_OF_CONDUCT.he.md").match(/^\d\. \*\*/gm)?.length).toBe(4);
    const beta = read(".github/DISCUSSION_TEMPLATE/beta.yml");
    expect(beta).toMatch(/required: true\s*$/m);
    expect(beta).toContain("CODE_OF_CONDUCT.md");
    expect(existsSync(join(root, ".github/DISCUSSION_TEMPLATE/beta-feedback.yml"))).toBe(true);
    for (const f of ["docs/src/content/docs/project/community.md", "docs/src/content/docs/he/project/community.md"]) expect(existsSync(join(root, f))).toBe(true);
  });

  it("the launch kit is complete, says nothing is posted, and counts testers only by the voluntary survey", () => {
    for (const f of ["README.md", "checklist.md", "launch-plan.md", "landing-copy.he.md", "landing-copy.en.md", "press-kit.md", "survey.md"]) expect(existsSync(join(root, "launch", f)), f).toBe(true);
    expect(read("launch/README.md")).toMatch(/Nothing in this folder is published or sent/);
    expect(read("launch/launch-plan.md")).toMatch(/Nothing is posted or sent from here/);
    expect(read("launch/launch-plan.md")).toMatch(/measured only by the voluntary weekly survey/);
    expect(read("launch/checklist.md")).toContain("npm run launch:check -- --strict");
    for (const f of ["landing-copy.he.md", "landing-copy.en.md", "press-kit.md"]) expect(read(`launch/${f}`)).not.toMatch(/world's (best|most)|the best |fastest/i);
  });
});
