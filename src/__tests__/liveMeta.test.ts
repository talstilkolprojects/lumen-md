/**
 * Plan W6.2 (E2): `npm run live:meta` fails when the live metadata names a
 * host that is not ours, and its self-test proves it (scripts/lib/liveMeta.mjs).
 * The domain that is not ours is built from parts, never written.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs script, no types
import { checkLiveMeta, foreignHost, goodPages, htmlMetaUrls, OUR_HOST, selfTest } from "../../scripts/lib/liveMeta.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { stepsFor } from "../../scripts/nightly/run.mjs";

const F = ["lumen", "md"].join(".");
const ROOT = join(__dirname, "../..");
type Pages = Record<string, { status: number; text: string }>;

/** What production served on 12.11.2026 (main 552ea5b70), the foreign host rebuilt from parts. */
function productionToday(): Pages {
  return {
    "index.html": {
      status: 200,
      text: [
        "<!doctype html><html><head>",
        `<meta property="og:url" content="https://${F}" />`,
        `<meta property="og:image" content="https://${F}/og-image.png" />`,
        `<meta name="twitter:image" content="https://${F}/og-image.png" />`,
        `<link rel="canonical" href="https://${F}" />`,
        `<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","url":"https://${F}"}</script>`,
        "</head><body></body></html>",
      ].join("\n"),
    },
    "robots.txt": { status: 200, text: `User-agent: *\nAllow: /\n\nSitemap: https://${F}/sitemap.xml\n` },
    "sitemap.xml": { status: 200, text: `<urlset>\n<url><loc>https://${F}/</loc></url>\n<url><loc>https://${F}/roadmap</loc></url>\n</urlset>` },
  };
}

describe("live:meta", () => {
  it("builds the foreign host from parts and never confuses it with ours", () => {
    expect(foreignHost()).toBe(F);
    expect(OUR_HOST).toBe("lumen-md.vercel.app");
    expect(checkLiveMeta(goodPages()).ok).toBe(true);
  });

  it("fails on what production serves today: 5 metadata URLs, robots and sitemap", () => {
    const r = checkLiveMeta(productionToday());
    expect(r.ok).toBe(false);
    const wrong = r.problems.filter((p: string) => p.includes(`points at ${F}`));
    expect(wrong).toHaveLength(8); // canonical, og:url, og:image, twitter:image, JSON-LD, Sitemap, 2 × <loc>
    expect(r.problems.filter((p: string) => p.includes("names the domain")).length).toBeGreaterThanOrEqual(8);
  });

  it("passes on #432's files (index.html, public/robots.txt, public/sitemap.xml) when they are on this branch", () => {
    const read = (p: string) => {
      try {
        return readFileSync(join(ROOT, p), "utf8");
      } catch {
        return null;
      }
    };
    const html = read("index.html");
    if (!html || !html.includes(`https://${OUR_HOST}`)) return; // the branch predates #432: covered by the other cases
    const r = checkLiveMeta({ "index.html": { status: 200, text: html }, "robots.txt": { status: 200, text: read("public/robots.txt") ?? "" }, "sitemap.xml": { status: 200, text: read("public/sitemap.xml") ?? "" } });
    expect(r.problems).toEqual([]);
  });

  it("reads canonical, og, twitter and JSON-LD however the attributes are ordered or quoted", () => {
    const urls = htmlMetaUrls(`<link href='https://a.example/x' rel='canonical'><meta content="https://b.example/" property="og:url"><meta name="twitter:image" content="https://c.example/i.png"><script type="application/ld+json">{"@context":"https://schema.org","author":{"url":"https://d.example/"}}</script>`);
    expect(urls.map((u: { where: string; url: string }) => `${u.where}=${u.url}`)).toEqual(["canonical=https://a.example/x", "og:url=https://b.example/", "twitter:image=https://c.example/i.png", "JSON-LD author.url=https://d.example/"]);
  });

  it("missing metadata, a broken JSON-LD and an HTTP error fail too", () => {
    const g = goodPages();
    const has = (pages: Pages, want: string[]) => {
      const got = checkLiveMeta(pages).problems;
      for (const w of want) expect(got).toContain(w);
    };
    has({ ...g, "index.html": { status: 200, text: "<html></html>" } }, ["index.html: no canonical", "index.html: no og:image", "index.html: no URL in JSON-LD"]);
    const broken = g["index.html"].text.replace(/\{"@context[^<]*/, "{nope");
    expect(checkLiveMeta({ ...g, "index.html": { status: 200, text: broken } }).problems).toContain("index.html: JSON-LD is not valid JSON");
    has({ ...g, "robots.txt": { status: 404, text: "" } }, ["robots.txt: HTTP 404", "robots.txt: no Sitemap line"]);
    has({ "index.html": g["index.html"] }, ["robots.txt: not fetched", "sitemap.xml: not fetched"]);
  });

  it("self-test: every planted foreign reference is caught, and it refuses pages that already fail", () => {
    expect(selfTest()).toEqual([]);
    expect(selfTest(productionToday())[0]).toMatch(/already fail/);
  });

  it("the nightly runs it with --self-test every night (kind triage)", () => {
    const steps = stepsFor("triage", () => false);
    expect(steps.map((s: { id: string; cmd: string[] }) => `${s.id}: ${s.cmd.join(" ")}`)).toContain("live-meta: node scripts/live-meta.mjs --self-test");
  });
});
