/**
 * Plan 9.9 — the workspace mirrors in RTL because its chrome uses logical
 * properties, and arrow keys keep their visual meaning.
 *
 * Gate: no physical left / right in the app's own CSS and in the inline
 * styles of src/ui, src/layouts, src/components and App.tsx, except the
 * reasoned exceptions below. Physical → logical is the same in LTR, so the
 * gate costs nothing for English and keeps the Hebrew interface mirrored.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { arrowStep, rovingIndex } from "../lib/logicalKeys";

const ROOT = resolve(__dirname, "..", "..");

/** "file: the trimmed line" — physical on purpose. */
const ALLOWED = new Set([
  // CodeMirror's own cursor is a left border in every direction (the editor stays LTR).
  "src/index.css: border-left-color: hsl(var(--accent));",
  "src/index.css: border-left-width: 2px;",
  // Centred with translateX(-50%): symmetric.
  "src/index.css: left: 50%;",
  // Coordinates measured with getBoundingClientRect, which are physical.
  "src/ui/OnboardingTour.tsx: const [pos, setPos] = useState({ top: 0, left: 0, width: 0, height: 0 });",
  // Full-width strip: both sides at 0.
  "src/ui/PageView.tsx: left: 0,",
  "src/ui/PageView.tsx: right: 0,",
]);

const CSS_PHYSICAL = /^\s*((margin|padding|border)-(left|right)(-\w+)?|left|right)\s*:|text-align:\s*(left|right)\b|float:\s*(left|right)\b/;
const TSX_PHYSICAL = /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft\w*|borderRight\w*)\s*:|\b(left|right)\s*:\s*[-\d"'`]|textAlign:\s*["'](left|right)["']/;
/** Tailwind's physical utilities (border-l, ml-2, right-4, text-left…); the logical ones are border-s, ms-2, end-4, text-start. */
const TW_PHYSICAL = /(?:^|[\s"'`])(?:[a-z]+:)*(?:border-[lr](?:-|\b)|[mp][lr]-[\d[]|(?:left|right)-[\d[]|text-(?:left|right)\b|rounded-[lr]-|rounded-[tb][lr]-)/;

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(join(ROOT, dir)).filter((n) => ext.test(n)).map((n) => `${dir}/${n}`);
}

function offenders(paths: string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const lines = readFileSync(join(ROOT, p), "utf8").split("\n");
    let inComment = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("/*")) inComment = !line.includes("*/");
      else if (inComment) {
        if (line.includes("*/")) inComment = false;
        continue;
      }
      if (line.startsWith("//") || line.startsWith("*")) continue;
      if (re.test(line) && !ALLOWED.has(`${p}: ${line}`)) out.push(`${p}: ${line}`);
    }
  }
  return out;
}

describe("logical properties in the chrome (plan 9.9)", () => {
  it("the app CSS has no physical left / right outside the exceptions", () => {
    expect(offenders(["src/index.css", ...files("src/ui", /\.css$/)], CSS_PHYSICAL)).toEqual([]);
  });

  it("inline styles have no physical left / right outside the exceptions", () => {
    const tsx = [...files("src/ui", /\.tsx$/), ...files("src/layouts", /\.tsx$/), ...files("src/components", /\.tsx$/), "src/App.tsx"];
    expect(offenders(tsx, TSX_PHYSICAL)).toEqual([]);
  });

  it("Tailwind classes use the logical utilities", () => {
    const tsx = [...files("src/ui", /\.tsx$/), ...files("src/layouts", /\.tsx$/), ...files("src/components", /\.tsx$/), "src/App.tsx"];
    expect(offenders(tsx, TW_PHYSICAL)).toEqual([]);
  });

  it("the gate sees a physical property when there is one", () => {
    expect(CSS_PHYSICAL.test("padding-left: 4px;")).toBe(true);
    expect(CSS_PHYSICAL.test("padding-inline-start: 4px;")).toBe(false);
    expect(TSX_PHYSICAL.test("marginLeft: 4,")).toBe(true);
    expect(TSX_PHYSICAL.test("right: 16,")).toBe(true);
    expect(TSX_PHYSICAL.test("insetInlineEnd: 16,")).toBe(false);
    expect(TW_PHYSICAL.test('className="h-full border-l border-border"')).toBe(true);
    expect(TW_PHYSICAL.test('className="fixed bottom-4 right-4"')).toBe(true);
    expect(TW_PHYSICAL.test('className="h-full border-s border-border ps-2 end-4"')).toBe(false);
    expect(TW_PHYSICAL.test('className="dark:border-l-sky-500"')).toBe(true);
  });

  it("no [dir=\"rtl\"] patch rules are left for what logical properties do", () => {
    const css = readFileSync(join(ROOT, "src/index.css"), "utf8");
    expect(css).not.toMatch(/\[dir="rtl"\] \.(file-tree|backlinks-panel|outline-link)/);
  });
});

describe("arrow keys keep their visual meaning", () => {
  it("→ is next in LTR and previous in RTL; ← the other way", () => {
    expect(arrowStep("ArrowRight", "ltr")).toBe(1);
    expect(arrowStep("ArrowLeft", "ltr")).toBe(-1);
    expect(arrowStep("ArrowRight", "rtl")).toBe(-1);
    expect(arrowStep("ArrowLeft", "rtl")).toBe(1);
    expect(arrowStep("ArrowUp", "rtl")).toBe(0);
  });

  it("roving focus wraps and honours Home / End", () => {
    expect(rovingIndex("ArrowRight", "ltr", 2, 3)).toBe(0);
    expect(rovingIndex("ArrowRight", "rtl", 0, 3)).toBe(2);
    expect(rovingIndex("ArrowLeft", "rtl", 1, 3)).toBe(2);
    expect(rovingIndex("Home", "rtl", 2, 3)).toBe(0);
    expect(rovingIndex("End", "ltr", 0, 3)).toBe(2);
    expect(rovingIndex("Enter", "ltr", 0, 3)).toBeNull();
    expect(rovingIndex("ArrowLeft", "ltr", 0, 0)).toBeNull();
  });
});
