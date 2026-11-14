/**
 * Plan 9.7: the direction of a Markdown line, by the golden set's rule
 * (eval/golden/bidi), with strong classes from a table generated from
 * bidi-js. Unit-level checks use the committed dev split only.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownLineDirection, strongDirection } from "../lib/bidiDirection";
// @ts-expect-error -- plain .mjs script, no types
import { encodeStrongTable, render } from "../../scripts/gen-bidi-strong.mjs";

const ROOT = join(__dirname, "../..");
const dev = JSON.parse(readFileSync(join(ROOT, "eval/golden/bidi/dev/lines.json"), "utf8")) as {
  items: Array<{ id: string; line: string; dir: "rtl" | "ltr" | "neutral" }>;
};

describe("markdownLineDirection on the bidi golden set (dev split)", () => {
  it.each(dev.items.map((it) => [it.id, it.line, it.dir] as const))("%s: %s → %s", (_id, line, dir) => {
    expect(markdownLineDirection(line) ?? "neutral").toBe(dir);
  });
});

describe("markdownLineDirection rules", () => {
  it("skips Markdown markers, link URLs and code spans", () => {
    expect(markdownLineDirection("> `iPhone` הפגישה נדחתה")).toBe("rtl");
    expect(markdownLineDirection("- [x] 10:30 Talk tomorrow")).toBe("ltr");
    expect(markdownLineDirection("1. [שלום](https://example.com/a)")).toBe("rtl");
    expect(markdownLineDirection("[](https://example.com) שלום")).toBe("rtl");
    expect(markdownLineDirection("``a`b`` עברית")).toBe("rtl");
    // Balanced parentheses in a destination (review: #252).
    expect(markdownLineDirection("[42](https://x/(foo)/english) שלום")).toBe("rtl");
    expect(markdownLineDirection("[42](https://x/a\\)b/english) שלום")).toBe("rtl");
    // An angle-bracketed destination may hold an unmatched parenthesis (review: #252).
    expect(markdownLineDirection("[42](<https://x/foo(bar>) שלום")).toBe("rtl");
    expect(markdownLineDirection('[42](https://x "English title") שלום')).toBe("rtl");
    // A code span closes at a run of exactly its opening length (review: #252).
    expect(markdownLineDirection("`a``b` שלום")).toBe("rtl");
    expect(markdownLineDirection("`` a`b `` שלום")).toBe("rtl");
    expect(markdownLineDirection("`unclosed שלום")).toBe("ltr");
    // An unclosed "(" is text, not a destination.
    expect(markdownLineDirection("[42](abc")).toBe("ltr");
  });

  it("treats RLM / LRM as strong and numbers, emoji and punctuation as neutral", () => {
    expect(markdownLineDirection("‏10:30 PDF")).toBe("rtl");
    expect(markdownLineDirection("‎10:30 שלום")).toBe("ltr");
    expect(markdownLineDirection("## 42% 😀 … (3) #1")).toBeNull();
    expect(markdownLineDirection("")).toBeNull();
  });

  it("covers scripts beyond Hebrew, Arabic and Latin", () => {
    expect(strongDirection("न".codePointAt(0)!)).toBe("ltr"); // Devanagari
    expect(strongDirection("ܐ".codePointAt(0)!)).toBe("rtl"); // Syriac
    expect(strongDirection("־".codePointAt(0)!)).toBe("rtl"); // Hebrew maqaf is R
    expect(strongDirection("٣".codePointAt(0)!)).toBeNull(); // Arabic-Indic digit is AN
    expect(strongDirection("ְ".codePointAt(0)!)).toBeNull(); // Hebrew point is NSM
    expect(strongDirection(0x1f600)).toBeNull();
  });
});

describe("the strong-class table", () => {
  it("matches bidi-js (regenerate with node scripts/gen-bidi-strong.mjs)", () => {
    const file = readFileSync(join(ROOT, "src/lib/bidiStrong.generated.ts"), "utf8");
    expect(file).toBe(render(encodeStrongTable()));
  }, 60_000);
});
