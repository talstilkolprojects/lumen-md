/** Plan W7.9: a note's language tag from its front matter, or Yiddish from its text. */
import { describe, expect, it } from "vitest";
import { canonicalTag, noteLanguage, wantsHebrewFont } from "../text/noteLanguage";
import { mayHaveLanguage } from "../text/noteLanguageLoader";

describe("note language tags (W7.9)", () => {
  it("reads lang: from the front matter, with its direction", () => {
    expect(noteLanguage("---\nlang: yi\n---\nאַ ליד")).toEqual({ tag: "yi", dir: "rtl", source: "frontmatter" });
    expect(noteLanguage("---\nlanguage: lad-Latn\n---\nKe haber?")).toEqual({ tag: "lad-Latn", dir: "ltr", source: "frontmatter" });
    expect(noteLanguage("---\nlang: LAD_hebr\n---\nקי חאבֿיר")?.tag).toBe("lad-Hebr");
    expect(noteLanguage("---\nlang: he\n---\nשלום")?.dir).toBe("rtl");
    expect(noteLanguage("---\nlang: fr\n---\nBonjour")?.dir).toBe("ltr");
  });

  it("resolves plain lad by the note's script", () => {
    expect(noteLanguage("---\nlang: lad\n---\nAki Yerushalayim")?.tag).toBe("lad-Latn");
    expect(noteLanguage("---\nlang: lad\n---\nאקי ירושלים")?.tag).toBe("lad-Hebr");
  });

  it("detects a Yiddish note without front matter, and leaves Hebrew and English alone", () => {
    expect(noteLanguage("# ייִדיש\n\nמיר וווינען אין דער שטאָט און לייענען ביכער אויף ייִדיש.")).toEqual({ tag: "yi", dir: "rtl", source: "detected" });
    expect(noteLanguage("# שלום\n\nאני גר בעיר הגדולה ואוהב לקרוא ספרים.")).toBeNull();
    expect(noteLanguage("# Hello\n\nPlain English.")).toBeNull();
  });

  it("refuses what is not a language tag", () => {
    expect(canonicalTag("yi")).toBe("yi");
    expect(canonicalTag("not a tag")).toBeNull();
    expect(noteLanguage("---\nlang: <script>\n---\nx")).toBeNull();
  });

  it("loads the language module only when a note may have one, and the Hebrew face only for Hebrew-letter Jewish languages", () => {
    expect(mayHaveLanguage("# Hello")).toBe(false);
    expect(mayHaveLanguage("---\nlang: lad\n---\n")).toBe(true);
    expect(mayHaveLanguage("שלום")).toBe(true);
    expect(wantsHebrewFont("yi")).toBe(true);
    expect(wantsHebrewFont("lad-Hebr")).toBe(true);
    expect(wantsHebrewFont("lad-Latn")).toBe(false);
    expect(wantsHebrewFont("he")).toBe(false);
  });
});
