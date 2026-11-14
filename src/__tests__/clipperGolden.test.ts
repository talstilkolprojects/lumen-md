/**
 * Plan 4.15 acceptance: clipping the golden pages (7.10, set "clipper") gets
 * the title and body right on ≥ 90 % of them. A page counts as right when
 * the title is exact, every article paragraph is in the clip in order, and
 * no noise block (mustExclude) is.
 *
 * The repo holds the dev split (5 pages). The 15 test pages are rebuilt in
 * CI with GOLDEN_SEED; when GOLDEN_TEST_DIR points at that build, they are
 * scored too.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPage } from "../research/clipExtract";

interface Item {
  id: string;
  file: string;
  lang: string;
  expected: { title: string; author: string; headings: string[]; paragraphs: string[]; mustInclude: string[]; mustExclude: string[] };
}

const root = join(__dirname, "..", "..");
const norm = (s: string) => s.replace(/[*_`\\]/g, "").replace(/\s+/g, " ").trim();

function load(dir: string): Array<{ item: Item; html: string }> {
  const pages = join(dir, "pages.json");
  if (!existsSync(pages)) return [];
  const items = (JSON.parse(readFileSync(pages, "utf8")) as { items: Item[] }).items;
  return items.map((item) => ({ item, html: readFileSync(join(dir, item.file), "utf8") }));
}

export function score({ item, html }: { item: Item; html: string }) {
  const r = extractPage(html, `https://golden.example/${item.id}`);
  const body = norm(r.markdown);
  const titleOk = r.title === item.expected.title;
  let at = 0;
  let inOrder = 0;
  for (const p of item.expected.paragraphs) {
    const i = body.indexOf(norm(p), at);
    if (i >= 0) {
      inOrder++;
      at = i + 1;
    }
  }
  const noise = item.expected.mustExclude.filter((s) => s.trim() && body.includes(norm(s)));
  const recall = inOrder / item.expected.paragraphs.length;
  return { id: item.id, titleOk, title: r.title, recall, noise, ok: titleOk && recall === 1 && noise.length === 0 };
}

const sets: Array<[string, string]> = [["dev", join(root, "eval/golden/clipper/dev")]];
if (process.env.GOLDEN_TEST_DIR) sets.push(["test", join(process.env.GOLDEN_TEST_DIR, "clipper/test")]);

describe("clipper v2 on the golden pages (plan 4.15)", () => {
  for (const [split, dir] of sets) {
    const pages = load(dir);
    it(`${split} split: title + body right on ≥ 90% of ${pages.length} pages`, () => {
      expect(pages.length).toBeGreaterThan(0);
      const results = pages.map(score);
      const bad = results.filter((r) => !r.ok);
      const rate = (results.length - bad.length) / results.length;
      // Shown in the CI log: what failed and why.
      if (bad.length) console.log(JSON.stringify(bad, null, 1));
      console.log(`clipper ${split}: ${results.length - bad.length}/${results.length} right (${Math.round(rate * 100)}%)`);
      expect(rate).toBeGreaterThanOrEqual(0.9);
    }, 30_000);
  }
});
