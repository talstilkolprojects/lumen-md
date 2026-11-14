/**
 * W4.16: a `.base` nested deeper than MAX_BASE_NESTING is refused before the
 * YAML parser sees it (the fuzz run found 3 KB files of nested `[` taking
 * 0.6–2 s); real files are untouched.
 */
import { describe, expect, it } from "vitest";
import { MAX_BASE_NESTING, parseBase } from "../views/bases/base";

describe("parseBase nesting bound (W4.16)", () => {
  it("refuses a file nested deeper than the bound, fast, without throwing", () => {
    const deep = `filters:\n  and:\n    - ${"[".repeat(5000)}x${"]".repeat(5000)}\n`;
    const t = performance.now();
    const r = parseBase(deep);
    expect(performance.now() - t).toBeLessThan(50);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(MAX_BASE_NESTING));
    const unclosed = `views:\n  - ${"{".repeat(MAX_BASE_NESTING + 1)}\n`;
    expect(parseBase(unclosed).ok).toBe(false);
  });

  it("keeps a real file, flow collections and brackets in strings included", () => {
    const real = [
      "filters:",
      '  and:',
      '    - file.hasTag("book")',
      '    - \'rating >= [3]\'',
      "views:",
      "  - type: table",
      "    name: Books",
      "    order: [file.name, author, rating]",
      "    sort: [{ property: rating, direction: DESC }]",
    ].join("\n");
    const r = parseBase(real);
    expect(r.ok).toBe(true);
    // Exactly at the bound the YAML parser decides, not the bound.
    const atBound = parseBase(`views:\n  - order: ${"[".repeat(MAX_BASE_NESTING)}a${"]".repeat(MAX_BASE_NESTING)}\n`);
    expect(atBound.ok ? "" : atBound.error).not.toContain("nested deeper");
  });
});
