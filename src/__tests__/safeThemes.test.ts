/**
 * W1.21 — safe themes and CSS snippets: the sanitizer (nothing that can
 * reach the network survives, however it is spelled), the five built-in
 * themes at WCAG AA in light and dark, the Hebrew theme's typography, and
 * snippets read from the vault's `.lumen/snippets`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { decodeEscapes, safeUrlTarget, sanitizeCss, tokenize } from "../theme/cssSanitizer";
import { PRESETS, PRESET_IDS, PRESET_TYPOGRAPHY, STYLESHEET_PALETTE, contrastReport, cssVariablesFor, DEFAULT_THEME_SETTINGS, MANAGED_VARS, type ThemeSettings } from "../lib/themeSettings";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { writeWorkspaceFile } from "../storage/workspace";
import { listSnippets, loadSnippet } from "../theme/snippets";

/** What survives: any url()/image-set() left must be data: or a #fragment, and no @import. */
function assertNoNetwork(css: string) {
  expect(css).not.toMatch(/@import/i);
  for (const t of tokenize(css)) {
    if (t.t === "url") expect(safeUrlTarget(t.target), t.v).toBe(true);
    if (t.t === "function" && ["url", "src", "image-set", "-webkit-image-set", "image", "cross-fade", "element"].includes(t.name)) {
      // A loading function may only remain around a safe string.
      expect(css.slice(css.indexOf(t.v)).match(/^[^(]*\(\s*(["'])(.*?)\1/)?.[2] ?? "", t.v).toMatch(/^(data:|#)/);
    }
  }
}

const HOSTILE: Array<[string, string]> = [
  ["plain url", "body { background: url(https://evil.example/a.png) }"],
  ["protocol-relative", ".a { background-image: url(//evil.example/a) }"],
  ["quoted", ".a { background: url('https://evil.example/a') }"],
  ["double quoted, spaced", ".a { background: url(  \"https://evil.example/a\"  ) }"],
  ["upper case", ".a { background: URL(https://evil.example/a) }"],
  ["escaped name", ".a { background: u\\72l(https://evil.example/a) }"],
  ["escaped name, hex with space", ".a { background: \\75 \\72 \\6c (https://evil.example/a) }"],
  ["escape in the target", ".a { background: url(ht\\74ps://evil.example/a) }"],
  ["relative path", ".a { background: url(x.png) }"],
  ["custom property", ".a { --x: url(https://evil.example/a); background: var(--x) }"],
  ["inside var() fallback", ".a { background: var(--nope, url(https://evil.example/a)) }"],
  ["@import url", '@import url("https://fonts.googleapis.com/css2?family=Heebo");'],
  ["@import string", '@import "https://evil.example/x.css";'],
  ["@import local", '@import "other.css";'],
  ["escaped @import", "@\\69mport 'https://evil.example/x.css';"],
  ["@font-face", "@font-face { font-family: X; src: url(https://evil.example/f.woff2) format('woff2') }"],
  ["image-set", ".a { background: image-set('https://evil.example/a.png' 1x) }"],
  ["-webkit-image-set", ".a { background: -webkit-image-set(url(https://evil.example/a.png) 1x) }"],
  ["cursor", ".a { cursor: url(https://evil.example/c.cur), auto }"],
  ["list-style", "li { list-style: url(https://evil.example/b.png) }"],
  ["mask", ".a { mask-image: url(https://evil.example/m.svg) }"],
  ["border-image", ".a { border-image: url(https://evil.example/b.png) 30 }"],
  ["in @media", "@media (min-width: 1px) { .a { background: url(https://evil.example/a) } }"],
  ["in @supports", "@supports (display: grid) { .a { background: url(https://evil.example/a) } }"],
  ["attr() url", ".a { background: attr(data-src url) }"],
  ["data: html", ".a { background: url(data:text/html,<script>alert(1)</script>) }"],
  ["expression", ".a { width: expression(alert(1)) }"],
  ["behavior", ".a { behavior: url(x.htc) }"],
  ["-moz-binding", ".a { -moz-binding: url(https://evil.example/x.xml#b) }"],
  ["@document", "@-moz-document url-prefix() { .a { color: red } }"],
  ["comment-split", ".a { background: url/**/(https://evil.example/a) }"],
  ["unterminated", ".a { background: url(https://evil.example/a"],
];

describe("the CSS sanitizer", () => {
  for (const [name, css] of HOSTILE) {
    it(`removes: ${name}`, () => {
      const r = sanitizeCss(css);
      assertNoNetwork(r.css);
      expect(r.css).not.toContain("evil.example");
    });
  }

  it("keeps everything else, byte for byte", () => {
    const css = `/* mine */\n:root { --radius-md: 10px }\n.cm-content { caret-color: hsl(var(--accent)); font-family: "Frank Ruehl CLM", serif }\n@media (prefers-color-scheme: dark) { .a { color: hsl(0 0% 90%) } }\n.b::before { content: "url(https://not-a-load)"; }\n.c { background: url("data:image/png;base64,iVBORw0KGgo=") }\n.d { mask: url(#m) }\n`;
    const r = sanitizeCss(css);
    expect(r.css).toBe(css);
    expect(r.removed).toEqual([]);
  });

  it("removes only the declaration, and says where and why", () => {
    const r = sanitizeCss(".a {\n  color: red;\n  background: url(https://evil.example/a);\n  margin: 0;\n}\n@import 'x.css';\n");
    expect(r.css).toBe(".a {\n  color: red;\n  \n  margin: 0;\n}\n\n");
    expect(r.removed.map((x) => [x.line, x.reason])).toEqual([
      [3, "remote-url"],
      [6, "import"],
    ]);
  });

  it("is idempotent", () => {
    for (const [, css] of HOSTILE) {
      const once = sanitizeCss(css).css;
      expect(sanitizeCss(once).css).toBe(once);
    }
  });

  it("decodes escapes the way the browser does", () => {
    expect(decodeEscapes("u\\72l")).toBe("url");
    expect(decodeEscapes("\\75 \\72 \\6c ")).toBe("url");
    expect(decodeEscapes("\\(")).toBe("(");
    expect(safeUrlTarget("data:image/svg+xml,%3Csvg%3E")).toBe(true);
    expect(safeUrlTarget("data:text/css,x")).toBe(false);
    expect(safeUrlTarget("'#frag'")).toBe(true);
  });
});

describe("the five built-in themes", () => {
  it("are five, one of them for Hebrew", () => {
    expect(PRESET_IDS).toEqual(["default", "sepia", "nord", "highContrast", "hebrew"]);
    expect(PRESET_TYPOGRAPHY.hebrew?.fontFamily).toBe("hebrew");
  });

  for (const id of ["default", "sepia", "nord", "highContrast", "hebrew"] as const) {
    for (const mode of ["light", "dark"] as const) {
      it(`${id} (${mode}) passes WCAG AA: text and muted 4.5:1, accent 3:1, text on accent 4.5:1`, () => {
        const palette = PRESETS[id][mode] ?? STYLESHEET_PALETTE[mode];
        for (const c of contrastReport(palette)) expect(c.ratio, `${c.id}: ${c.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(c.required);
      });
    }
  }

  it("the Hebrew theme sets a Hebrew serif and roomy lines in the editor and the preview", () => {
    const s: ThemeSettings = { ...DEFAULT_THEME_SETTINGS, preset: "hebrew", ...PRESET_TYPOGRAPHY.hebrew! };
    const vars = cssVariablesFor(s, false);
    expect(vars["--editor-font"]).toMatch(/Frank Ruehl CLM/);
    expect(vars["--font-serif"]).toMatch(/David/);
    expect(Number(vars["--preview-line-height"])).toBeGreaterThanOrEqual(1.8);
    expect(MANAGED_VARS).toContain("--font-serif");
    // Other themes leave the preview font alone.
    expect(cssVariablesFor({ ...DEFAULT_THEME_SETTINGS, preset: "sepia" }, false)["--font-serif"]).toBe(undefined);
  });

  it("only documented tokens are written", () => {
    for (const id of PRESET_IDS) for (const dark of [false, true]) for (const k of Object.keys(cssVariablesFor({ ...DEFAULT_THEME_SETTINGS, preset: id, ...(PRESET_TYPOGRAPHY[id] ?? {}) }, dark))) expect(MANAGED_VARS).toContain(k);
  });
});

describe("snippets from the vault", () => {
  beforeEach(() => {
    installFakeOpfs();
  });

  it("lists .lumen/snippets (and .obsidian/snippets), sanitized", async () => {
    await writeWorkspaceFile(".lumen/snippets/wide.css", ".cm-content { max-width: none }");
    await writeWorkspaceFile(".lumen/snippets/evil.css", "@import 'https://evil.example/x.css';\nbody { background: url(https://evil.example/a) }");
    await writeWorkspaceFile(".obsidian/snippets/wide.css", "/* shadowed by .lumen */");
    await writeWorkspaceFile(".obsidian/snippets/obs.css", "h1 { color: hsl(var(--accent)) }");
    await writeWorkspaceFile("notes/not-a-snippet.css", "x{}");
    const list = await listSnippets();
    expect(list.map((s) => s.path)).toEqual([".lumen/snippets/evil.css", ".obsidian/snippets/obs.css", ".lumen/snippets/wide.css"]);
    const evil = await loadSnippet(list[0]);
    expect(evil.result.removed.map((r) => r.reason)).toEqual(["import", "remote-url"]);
    expect(evil.result.css).not.toContain("evil.example");
  });
});
