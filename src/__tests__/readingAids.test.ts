/** Plan W5.6: the dyslexia-friendly layout's settings, the CSS it puts on the page, and the faces it downloads. */
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AIDS_FACES, AIDS_KEY, DEFAULT_AIDS, aidsAttributes, facesFor, fontStack, loadAids, normalizeAids, saveAids, TINTS } from "../reading/readingAids";

const ROOT = resolve(__dirname, "../..");

beforeEach(() => localStorage.clear());

describe("reading aids", () => {
  it("defaults to the WCAG 1.4.12 spacing with taller lines, off until turned on", () => {
    expect(DEFAULT_AIDS).toMatchObject({ dyslexia: false, letterSpacing: 0.12, wordSpacing: 0.16, lineHeight: 1.8, font: "notoSansHebrew" });
  });

  it("normalizes anything stored: unknown values fall back, numbers are clamped", () => {
    expect(normalizeAids({ dyslexia: true, font: "comic", tint: "pink", letterSpacing: 9, wordSpacing: -1, lineHeight: "2", rate: 0.1 })).toEqual({
      ...DEFAULT_AIDS,
      dyslexia: true,
      letterSpacing: 0.35,
      wordSpacing: 0,
      rate: 0.5,
    });
    expect(normalizeAids("garbage")).toEqual(DEFAULT_AIDS);
  });

  it("saves and loads; broken storage gives the defaults", () => {
    saveAids({ ...DEFAULT_AIDS, dyslexia: true, tint: "blue", rate: 1.25 });
    expect(loadAids()).toMatchObject({ dyslexia: true, tint: "blue", rate: 1.25 });
    // src/main.tsx applies stored aids at startup by this exact substring
    expect(localStorage.getItem(AIDS_KEY)).toContain('"dyslexia":true');
    localStorage.setItem(AIDS_KEY, "{not json");
    expect(loadAids()).toEqual(DEFAULT_AIDS);
  });

  it("off: every attribute and variable is removed", () => {
    const { attrs, vars } = aidsAttributes(DEFAULT_AIDS);
    expect(Object.values(attrs).every((v) => v === null)).toBe(true);
    expect(Object.values(vars).every((v) => v === null)).toBe(true);
  });

  it("on: spacing, face and tint reach the page as variables", () => {
    const { attrs, vars } = aidsAttributes({ ...DEFAULT_AIDS, dyslexia: true, tint: "green", lineFocus: false, letterSpacing: 0.2 });
    expect(attrs).toEqual({ "data-reading-aids": "on", "data-reading-tint": "green", "data-reading-focus": null });
    expect(vars["--ra-letter"]).toBe("0.2em");
    expect(vars["--ra-bg-light"]).toBe(TINTS.green.light);
    expect(vars["--ra-font"]).toContain("Lumen Noto Sans Hebrew");
  });

  it("OpenDyslexic has no Hebrew letters, so Hebrew falls through to Noto Sans Hebrew", () => {
    expect(fontStack("openDyslexic").indexOf("Lumen OpenDyslexic")).toBeLessThan(fontStack("openDyslexic").indexOf("Lumen Noto Sans Hebrew"));
    expect(facesFor("openDyslexic")).toEqual(["openDyslexic", "notoSansHebrew"]);
    expect(facesFor("app")).toEqual([]);
  });

  it("every face file is in public/ with the byte count declared, under the SIL Open Font License", () => {
    for (const face of Object.values(AIDS_FACES)) {
      for (const f of face.files) expect(statSync(resolve(ROOT, "public", f.path)).size, f.path).toBe(f.bytes);
      expect(existsSync(resolve(ROOT, "public", face.license))).toBe(true);
      expect(readFileSync(resolve(ROOT, "public", face.license), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  it("each tint keeps body text at 7:1 or more (light theme text #1f2937, dark #e5e7eb)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    for (const t of Object.values(TINTS)) {
      expect(ratio(t.light, "#1f2937")).toBeGreaterThanOrEqual(7);
      expect(ratio(t.dark, "#e5e7eb")).toBeGreaterThanOrEqual(7);
    }
  });
});
