/** 9.3 — logical CSS in the preview and editor rules; Unicode page slugs in the site export. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { findCssViolations } from "../../scripts/check-code-hygiene.mjs";
import { pageFileSlug } from "../lib/slug";
import { markdownToStaticSiteBytes } from "../storage/exportFormats";
import { unzip } from "../storage/zip";

type Violation = { line: number; rule: string; text: string };
const css = (src: string): Violation[] => findCssViolations("x.css", src);

describe("hygiene: physical CSS in .prose-lumen / .cm-* rules", () => {
  it("flags physical properties and values, and names the logical one", () => {
    const v = css(
      [
        ".prose-lumen blockquote { margin-left: 1rem; padding-right: 2px; border-left: 3px solid; }",
        ".cm-editor .cm-tooltip { left: 0; text-align: right; float: left; border-top-left-radius: 4px; }",
      ].join("\n"),
    );
    expect(v.map((x) => x.text.split(" → ")[1])).toEqual([
      "margin-inline-start",
      "padding-inline-end",
      "border-inline-start",
      "inset-inline-start",
      "text-align: end",
      "float: start (inline-start / inline-end)",
      "border-start-start-radius",
    ]);
    expect(v.every((x) => x.rule === "physical-css" && x.line >= 1)).toBe(true);
  });

  it("flags shorthands that set left and right differently, not symmetric ones (review: #219)", () => {
    const v = css(
      [
        ".prose-lumen blockquote { border-radius: 0 0.5rem 0.5rem 0; }",
        ".prose-lumen aside { border-radius: 4px 0; }",
        ".prose-lumen dl { border-radius: 2px 4px 6px; }",
        ".prose-lumen dd { margin: 0 1rem 0 2rem; }",
        ".cm-panel { padding: 1px calc(2px + 1px) 3px 0; }",
        ".prose-lumen figure { border-width: 1px 2px 1px 0; }",
      ].join("\n"),
    );
    expect(v).toHaveLength(6);
    expect(v[0].text).toContain("border-start-end-radius");
    expect(v[3].text).toContain("margin-inline-start");
    expect(
      css(
        [
          ".prose-lumen img { border-radius: 0.5rem; }",
          ".prose-lumen .a { border-radius: 4px 4px 0 0; }", // top corners only: symmetric
          ".prose-lumen .b { border-radius: 2px 2px 6px 6px; }",
          ".prose-lumen .c { border-radius: 4px / 2px; }",
          ".prose-lumen table { margin: 0 auto; }",
          ".cm-line { padding: 0 0.5rem; }",
          ".prose-lumen .d { margin: 1px 2px 3px 2px; }",
          ".prose-lumen .e { padding: 0 var(--gap) 0 var(--gap); }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("leaves logical properties and rules outside the preview and editor alone", () => {
    expect(
      css(
        [
          ".prose-lumen blockquote { margin-inline-start: 1rem; border-inline-start: 3px solid; text-align: start; inset-inline-end: 0 }",
          ".sidebar { margin-left: 4px; float: right }",
          ".prose-lumen table { text-align: center; margin: 0 auto }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("honours a justified hygiene-allow comment on the line or the line above", () => {
    expect(css(".cm-cursor {\n  /* hygiene-allow: CodeMirror's caret */\n  border-left-width: 2px;\n}")).toEqual([]);
    expect(css(".cm-cursor { border-left-width: 2px; /* hygiene-allow: caret */ }")).toEqual([]);
    expect(css(".cm-cursor {\n  /* hygiene-allow: */\n  border-left-width: 2px;\n}")).toHaveLength(1);
  });

  it("the app's own stylesheets pass", () => {
    const src = join(__dirname, "..");
    for (const f of ["index.css", "ui/CommandPalette.css", "ui/FileTree.css", "ui/PromptDialog.css"]) {
      expect(css(readFileSync(join(src, f), "utf8")), f).toEqual([]);
    }
  });
});

describe("site export page names (Unicode slugs)", () => {
  it("keeps Hebrew, Arabic and CJK titles readable, drops niqqud and punctuation", () => {
    expect(pageFileSlug("מדריך: התקנה (גרסה 2)", "page-1")).toBe("מדריך-התקנה-גרסה-2");
    expect(pageFileSlug("שָׁלוֹם עוֹלָם", "page-1")).toBe("שלום-עולם");
    expect(pageFileSlug("مرحبا بالعالم", "page-1")).toBe("مرحبا-بالعالم");
    expect(pageFileSlug("日本語のテスト", "page-1")).toBe("日本語のテスト");
    expect(pageFileSlug("Getting Started!", "page-1")).toBe("getting-started");
    expect(pageFileSlug("  ?! ", "page-4")).toBe("page-4");
    expect(Array.from(pageFileSlug("א".repeat(200), "p")).length).toBe(80);
  });

  it("a Hebrew site gets Hebrew page files, encoded links and an RTL page", async () => {
    const md = "# מדריך התקנה\n\nשלום.\n\n# שאלות נפוצות\n\n- אחת";
    const bytes = await markdownToStaticSiteBytes(md, "תיעוד");
    const files = await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const names = [...files.keys()];
    expect(names).toContain("מדריך-התקנה.html");
    expect(names).toContain("שאלות-נפוצות.html");
    expect(names.some((n) => /^page-\d/.test(n))).toBe(false); // the old ASCII-only slug turned both into page-N
    const page = new TextDecoder().decode(files.get("מדריך-התקנה.html")!);
    expect(page).toContain(`href="${encodeURIComponent("שאלות-נפוצות.html")}"`);
    expect(page).toContain('dir="rtl"');
    expect(page).toContain('aria-current="page"');
    expect(new TextDecoder().decode(files.get("style.css")!)).toContain("border-inline-end");
  });

  it("two titles with the same slug get distinct files", async () => {
    const bytes = await markdownToStaticSiteBytes("# שלום\n\nא\n\n# שָׁלוֹם\n\nב", "S");
    const names = [...(await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).keys()];
    expect(names.filter((n) => n.startsWith("שלום")).length).toBe(2);
  });
});
