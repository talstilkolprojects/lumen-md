/**
 * Plan W3.1 — the design system: tokens, the colour and motion gate, and
 * the 40-surface audit.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs scripts without types
import { keyframesOf, parseTransition, scan, scanAll } from "../../scripts/check-design.mjs";
// @ts-expect-error — plain .mjs scripts without types
import { audit, auditSource } from "../../scripts/design-audit.mjs";
import { color, enter, shadow, transition, withAlpha } from "../ui/tokens";

const ROOT = resolve(__dirname, "..", "..");
type Finding = { line: number; rule: string; text: string };
const rules = (file: string, text: string, strict = true): string[] => (scan(file, text, { strict, colors: true }) as Finding[]).map((f) => f.rule);

describe("the gate (scripts/check-design.mjs)", () => {
  it("finds hard-coded colours in strings and CSS, not in comments or token definitions", () => {
    expect(rules("x.tsx", `const a = { color: "#ef4444", b: "rgba(0,0,0,.5)", c: "hsl(0 70% 50%)" };`)).toEqual(["color", "color", "color"]);
    expect(rules("x.tsx", `// #ef4444 in a comment\nconst a = { color: "hsl(var(--danger))", b: "var(--overlay)" };`)).toEqual([]);
    expect(rules("x.css", `.a { color: #fff; }\n:root { --x: hsl(0 0% 0%); }\n/* #000 */`)).toEqual(["color"]);
  });

  it("layout never animates; in strict code only transform and opacity, on the duration scale", () => {
    expect(rules("x.tsx", `const s = { transition: "width 200ms ease" };`, false)).toEqual(["layout"]);
    expect(rules("x.tsx", `const s = { transition: "background 80ms" };`, false)).toEqual([]);
    expect(rules("x.tsx", `const s = { transition: "all 150ms ease" };`)).toEqual(["motion"]);
    expect(rules("x.tsx", `const s = { transition: "transform 120ms ease" };`)).toEqual(["motion"]);
    expect(rules("x.tsx", `const s = { transition: "transform var(--duration-fast) var(--ease-out), opacity 250ms" };`)).toEqual([]);
    expect(rules("x.tsx", `const s = { animation: "spin 1s linear infinite" };`)).toEqual([]);
    expect(rules("x.css", `@keyframes grow { from { height: 0 } to { height: 10px } }`, false)).toEqual(["layout"]);
    expect(rules("x.css", `@keyframes slide { from { opacity: 0; transform: translateY(4px) } }`)).toEqual([]);
  });

  it("honours a justified design-allow", () => {
    expect(rules("x.tsx", `const a = "#7c5cfc"; // design-allow: a note's own colour`)).toEqual([]);
  });

  it("parses transitions and keyframes", () => {
    expect(parseTransition("opacity 100ms ease, transform var(--duration-base) cubic-bezier(0, 0, 1, 1)")).toEqual([
      { prop: "opacity", duration: "100ms" },
      { prop: "transform", duration: "var(--duration-base)" },
    ]);
    expect([...keyframesOf("@keyframes a { 0% { opacity: 0 } 100% { opacity: 1; transform: none } }").get("a").props]).toEqual(["opacity", "transform"]);
  });

  it("src/: 0 hard-coded colours in src/ui, 0 layout animations, motion on the scale", () => {
    expect(scanAll()).toEqual([]);
  });
});

describe("the audit (scripts/design-audit.mjs)", () => {
  it("checks logical sides, the overlay and the shadow scale", () => {
    const src = `const A = () => <div style={{ marginLeft: 4, textAlign: "right", boxShadow: "0 1px 2px black" }} />;
const B = () => <div style={{ position: "fixed", inset: 0, background: "hsl(var(--bg) / 0.5)" }} />;`;
    const r = auditSource("x.tsx", src);
    expect(r.direction.map((d: { text: string }) => d.text)).toEqual(["marginLeft", "textAlign: right"]);
    expect(r.elevation).toHaveLength(1);
    expect(r.overlay).toHaveLength(1);
    expect(auditSource("y.tsx", `const A = () => <div style={{ marginInlineStart: 4, boxShadow: "var(--shadow-lg), 0 0 0 1px hsl(var(--accent) / 0.15)" }} />;`)).toEqual({ direction: [], overlay: [], elevation: [] });
  });

  it("40/40 surfaces pass the checklist", () => {
    const rows = audit() as { name: string; pass: boolean }[];
    expect(rows).toHaveLength(40);
    expect(rows.filter((r) => !r.pass).map((r) => r.name)).toEqual([]);
  });
});

describe("tokens", () => {
  const css = readFileSync(resolve(ROOT, "src/index.css"), "utf8");

  it("every token the TS module names is defined in index.css", () => {
    for (const name of ["danger", "success", "warning", "info", "overlay", "shadow-sm", "shadow-xl", "shadow-accent", "duration-fast", "duration-base", "duration-slow", "ease-out", "gradient-brand", "space-4", "radius-md", "text-md"]) {
      expect(css, name).toMatch(new RegExp(`--${name}:`));
    }
  });

  it("status colours are tuned for dark mode too", () => {
    const dark = css.slice(css.indexOf("  .dark {"), css.indexOf("}", css.indexOf("  .dark {")));
    for (const name of ["danger", "success", "warning", "info"]) expect(dark, name).toContain(`--${name}:`);
  });

  it("reduce motion sets the duration tokens to 0", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const d of ["fast", "base", "slow"]) expect(block).toContain(`--duration-${d}: 0ms`);
  });

  it("the helpers build token values, and transition() only takes transform and opacity", () => {
    expect(transition(["transform", "opacity"], "base")).toBe("transform var(--duration-base) var(--ease-out), opacity var(--duration-base) var(--ease-out)");
    expect(enter("cmdSlideIn")).toBe("cmdSlideIn var(--duration-fast) var(--ease-out)");
    expect(color.tint("danger", 0.1)).toBe("hsl(var(--danger) / 0.1)");
    expect(shadow.lg).toBe("var(--shadow-lg)");
    expect(withAlpha("hsl(120 70% 60%)", 0.35)).toBe("hsl(120 70% 60% / 0.35)");
  });
});
