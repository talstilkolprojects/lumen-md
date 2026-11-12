// @vitest-environment node
/**
 * Plan W5.25, sustainability: the support page loads no third-party script
 * (in fact nothing but itself and the favicon), every number it and the docs
 * quote matches the cost model, and FUNDING.yml points at the live page.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { breakEven, fixedMonthly, model, perUserMonthly, PRICES, USAGE } from "../../scripts/cost-model.mjs";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const page = read("public/support.html");
const docs = { en: read("docs/src/content/docs/project/sustainability.md"), he: read("docs/src/content/docs/he/project/sustainability.md") };

/** The page's markup without its comments (they describe what it doesn't load). */
const markup = page.replace(/<!--[\s\S]*?-->/g, "");

describe("support page", () => {
  it("runs no script and loads no resource from anywhere, its own origin included, but the favicon", () => {
    expect(markup).not.toMatch(/<script\b/i);
    expect(markup).not.toMatch(/<(iframe|frame|object|embed|img|picture|video|audio|source|track|form|base|portal)\b/i);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
    expect(markup).not.toMatch(/javascript:/i);
    expect(markup).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    expect(markup).not.toMatch(/\ssrc(set)?\s*=/i);
    // CSS can fetch too: no url(), no @import, no web fonts.
    const css = [...markup.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    expect(css).not.toMatch(/url\s*\(|@import|@font-face/i);
    expect(markup).not.toMatch(/style\s*=\s*["'][^"']*url\s*\(/i);
    // <link> only for the favicon, on this origin.
    const links = [...markup.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    expect(links).toEqual(['<link rel="icon" type="image/svg+xml" href="/favicon.svg" />']);
    // Other sites are only plain links: they load when clicked, not with the page.
    const external = [...markup.matchAll(/<(\w+)\b[^>]*\shref\s*=\s*"(https?:[^"]*)"/gi)];
    expect(external.length).toBeGreaterThan(3);
    for (const [, tag, href] of external) expect(tag, href).toBe("a");
    expect(markup).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("is Hebrew first, with the same content in English", () => {
    expect(page).toMatch(/<html lang="he" dir="rtl">/);
    expect(page.indexOf('lang="he"', 20)).toBeLessThan(page.indexOf('<section lang="en"'));
    const he = page.slice(page.indexOf('<section lang="he"'), page.indexOf('<section lang="en"'));
    const en = page.slice(page.indexOf('<section lang="en"'));
    const fields = (s: string) => [...s.matchAll(/data-(model|cost|total)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(fields(he)).toEqual(fields(en));
    expect(fields(he).length).toBeGreaterThan(12);
  });

  it("each cost table adds up to its total", () => {
    for (const table of page.split("<table>").slice(1)) {
      const total = /data-total="([\d.]+)"/.exec(table);
      if (!total) continue;
      const sum = [...table.matchAll(/data-cost="([\d.]+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
      expect(sum).toBe(Number(total[1]));
    }
  });

  it("every number matches scripts/cost-model.mjs", () => {
    const m = model() as unknown as Record<string, Record<string, number>>;
    const shown = [...page.matchAll(/data-model="([\w.]+)">([^<]+)</g)];
    expect(shown.length).toBe(20);
    for (const [, path, text] of shown) {
      const [group, key] = (path as string).split(".") as [string, string];
      const value = m[group]![key] as number;
      const expected = group === "breakEven" ? String(value) : group === "plans" ? `$${value}` : `$${value.toFixed(value < 1 ? 4 : 2)}`;
      expect(text, path).toBe(expected);
    }
  });
});

describe("cost model", () => {
  it("per user, per plan and break-even, as the docs quote them in English and Hebrew", () => {
    const m = model();
    expect(m.perUser.total).toBe(0.0496);
    expect(m.morFee).toEqual({ monthly: 0.695, yearly: 2.45 });
    expect(m.net).toEqual({ monthly: 2.2554, yearly: 2.2462 });
    expect(m.fixed).toEqual({ cloudflarePages: 5.87, vercelPro: 25.87 });
    expect(m.breakEven).toEqual({ cloudflarePages: 3, vercelPro: 12 });
    const atCap = perUserMonthly(PRICES, { ...USAGE, storedGb: 10 }).total;
    for (const doc of [docs.en, docs.he]) {
      for (const v of ["$0.0496", "$0.0150", "$0.0135", "$0.0108", "$0.0099", "$0.0005", "$0.6950", "$2.45", "$2.26", "$2.25", "$5.87", "$25.87", `$${atCap.toFixed(2)}`]) expect(doc, v).toContain(v);
    }
    expect(docs.en).toContain("**3 subscribers**");
    expect(docs.en).toContain("**12 subscribers**");
    expect(docs.he).toContain("**3 מנויים**");
    expect(docs.he).toContain("**12 מנויים**");
  });

  it("break-even moves the right way when costs or prices move", () => {
    const pricier = breakEven({ ...PRICES, workersPaidMonthly: 50 });
    expect(pricier.cloudflarePages).toBeGreaterThan(3);
    expect(fixedMonthly({ ...PRICES, hostingVercelPro: 0 }).vercelPro).toBe(fixedMonthly().cloudflarePages);
    expect(breakEven(PRICES, USAGE, { monthly: 10, yearly: 100 }).vercelPro).toBeLessThan(12);
  });
});

describe("FUNDING.yml", () => {
  const yml = read(".github/FUNDING.yml");
  const live = yml.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

  it("uses only keys GitHub reads, and links the live support page", () => {
    const allowed = ["community_bridge", "github", "issuehunt", "ko_fi", "liberapay", "open_collective", "otechie", "patreon", "tidelift", "polar", "buy_me_a_coffee", "thanks_dev", "lfx_crowdfunding", "custom"];
    for (const l of live) expect(allowed, l).toContain(l.split(":")[0]);
    expect(live).toEqual(['custom: ["https://lumen-md.vercel.app/support.html"]']);
    expect(existsSync(join(ROOT, "public/support.html"))).toBe(true);
    // The two accounts are ready to switch on once they exist.
    expect(yml).toContain("# github: [talstilkol]");
    expect(yml).toContain("# open_collective: lumen-md");
  });

  it("the sitemap lists the support page", () => {
    expect(read("public/sitemap.xml")).toContain("<loc>https://lumen-md.vercel.app/support.html</loc>");
  });
});
