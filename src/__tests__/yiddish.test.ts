/**
 * Plan W7.9: Yiddish in YIVO spelling ↔ YIVO romanisation, both ways, and
 * telling Yiddish from Hebrew.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEBRAISMS, isYiddishText, latinToYiddish, normalizeYiddish, yiddishToLatin } from "../text/yiddish";

const WORDS = readFileSync(join(__dirname, "fixtures/yiddish-words.txt"), "utf8")
  .split("\n")
  .filter((l) => !l.startsWith("#"))
  .join(" ")
  .split(/\s+/)
  .filter(Boolean);

describe("Yiddish ↔ YIVO romanisation (W7.9)", () => {
  it("romanises by the YIVO table", () => {
    expect(yiddishToLatin("ייִדיש איז אַ שפּראַך")).toBe("yidish iz a shprakh");
    expect(yiddishToLatin("מיר וווינען אין דער שטאָט")).toBe("mir voynen in der shtot");
    expect(yiddishToLatin("פֿליִען, צייַט, פּאָעזיע, אוניווערסיטעט, וווּ")).toBe("flien, tsayt, poezye, universitet, vu");
    expect(yiddishToLatin("טרויעריק אייער אויג")).toBe("troyerik eyer oyg");
  });

  it("writes Hebrew-origin words as YIVO does, both ways", () => {
    expect(yiddishToLatin("שבת און אמת")).toBe("shabes un emes");
    expect(latinToYiddish("mishpokhe")).toBe(normalizeYiddish("משפּחה"));
    expect(HEBRAISMS.length).toBeGreaterThan(60);
    for (const [y, l] of HEBRAISMS) expect(latinToYiddish(yiddishToLatin(y)), l).toBe(normalizeYiddish(y));
  });

  it("puts a shtumer alef before an initial vowel, final forms at the end, melupm vov next to a vov", () => {
    expect(latinToYiddish("un oyf eyner")).toBe(normalizeYiddish("און אויף איינער"));
    expect(latinToYiddish("Ikh hob lib mayn kind")).toBe(normalizeYiddish("איך האָב ליב מייַן קינד"));
    expect(latinToYiddish("vu")).toBe(normalizeYiddish("וווּ"));
    expect(latinToYiddish("brif")).toBe("בריף");
  });

  it(`round trip Yiddish → Latin → Yiddish: at least 98 % of ${WORDS.length} words come back`, () => {
    const back = WORDS.filter((w) => latinToYiddish(yiddishToLatin(w)) === normalizeYiddish(w));
    expect(WORDS.length).toBeGreaterThan(200);
    expect(back.length / WORDS.length).toBeGreaterThanOrEqual(0.98);
  });

  it("reads precomposed letters and ligatures as their base letters with points", () => {
    expect(normalizeYiddish("\uFB2E\u05F2\uFB1F\u05F0")).toBe("\u05D0\u05B7" + "\u05D9\u05D9" + "\u05D9\u05D9\u05B7" + "\u05D5\u05D5");
    expect(yiddishToLatin("\u05F2\u05B7\u05DF")).toBe("ayn");
  });

  it("tells Yiddish from Hebrew", () => {
    expect(isYiddishText("ייִדיש איז אַ שפּראַך פֿון דעם ייִדישן פֿאָלק")).toBe(true);
    expect(isYiddishText("מיר וווינען אין דער גרויסער שטאָט און לייענען ביכער")).toBe(true);
    expect(isYiddishText("אני גר בעיר הגדולה ואוהב לקרוא ספרים")).toBe(false);
    expect(isYiddishText("שלום עולם")).toBe(false);
  });
});
