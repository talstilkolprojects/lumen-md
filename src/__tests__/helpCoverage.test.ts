/**
 * W3.7 — 100% of panels have a "?": every component that renders a dialog
 * (role="dialog" / aria-modal) or a side panel (<aside>) has a HelpButton,
 * and every button's page and section exist in the packed docs, in English
 * and in Hebrew.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { HelpBundle } from "../help/helpSearch";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");
/** The help panel is the help. */
const NOT_PANELS = new Set(["src/ui/HelpPanel.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== "__tests__") walk(p, out);
    } else if (/\.tsx$/.test(n) && !/\.(test|spec)\.tsx$/.test(n)) out.push(p);
  }
  return out;
}

const panels = walk(SRC)
  .map((p) => ({ rel: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }))
  .filter((f) => !NOT_PANELS.has(f.rel) && (/role="dialog"|aria-modal/.test(f.text) || /<aside\b/.test(f.text)));
/** The packed docs of a language: every shard (scripts/help-bundle.mjs), joined. */
function packed(lang: "en" | "he"): HelpBundle {
  const dir = join(SRC, "help/generated");
  const files = readdirSync(dir)
    .map((n) => new RegExp(`^help\\.${lang}\\.(\\d+)\\.json$`).exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const parts = files.map((m) => JSON.parse(readFileSync(join(dir, m[0]), "utf8")) as HelpBundle);
  return { version: parts[0].version, lang, pages: parts.flatMap((p) => p.pages) };
}
const bundles = { en: packed("en"), he: packed("he") };

describe('every panel has a "?"', () => {
  it("finds the panels", () => {
    expect(panels.length).toBeGreaterThanOrEqual(28);
  });

  for (const f of panels) {
    it(`${f.rel} has a HelpButton to a page that exists in English and Hebrew`, () => {
      const topics = [...f.text.matchAll(/<HelpButton\s+topic="([^"]*)"/g)].map((m) => m[1]);
      expect(topics.length, f.rel).toBeGreaterThan(0);
      for (const topic of topics) {
        const [slug, key] = topic.split("#");
        for (const lang of ["en", "he"] as const) {
          const page = bundles[lang].pages.find((p) => p.slug === slug);
          expect(page, `${topic} (${lang})`).toBeDefined();
          if (key) expect(page!.sections.some((s) => s.key === key), `${topic} (${lang}): no section ${key}`).toBe(true);
        }
      }
    });
  }
});
