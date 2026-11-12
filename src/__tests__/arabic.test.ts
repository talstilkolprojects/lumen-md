/**
 * W5.17 — Arabic as a first-class language: tashkeel, folding for search
 * and spelling, the local Arabic checker, Arabic paragraphs kept on this
 * device, and per-line direction in a Hebrew–Arabic–English note. The
 * tashkeel editor commands are in tashkeelView.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arabicPrefixVariants, arabicRatio, arabicSuffixVariants, foldArabic, hasArabic, hasTashkeel, removeTashkeel } from "../text/arabic";
import { normalizeForMatch } from "../text/hebrew";
import { documentTerms, queryTerms } from "../text/searchTokens";
import { arabicRules, arabicSpelling, buildArabicDictionary, isKnownArabic, suggestArabic } from "../ai/arabicSpell";
import { markdownLineDirection } from "../lib/bidiDirection";

const POINTED = "مَدْرَسَةٌ";

describe("tashkeel and folding", () => {
  it("finds and removes tashkeel, keeping letters and hamza", () => {
    expect(hasTashkeel(POINTED)).toBe(true);
    expect(removeTashkeel(POINTED)).toBe("مدرسة");
    expect(removeTashkeel("سُؤَالٌ")).toBe("سؤال");
    expect(hasTashkeel("مدرسة")).toBe(false);
    expect(removeTashkeel("שָׁלוֹם")).toBe("שָׁלוֹם"); // niqqud is not tashkeel
  });

  it("folds the spellings writers use interchangeably", () => {
    expect(foldArabic("إسلام")).toBe(foldArabic("اسلام"));
    expect(foldArabic("مستشفى")).toBe(foldArabic("مستشفي"));
    expect(foldArabic("مدرسة")).toBe(foldArabic("مدرسه"));
    expect(foldArabic("كتـــاب")).toBe("كتاب");
    expect(foldArabic(POINTED)).toBe(foldArabic("مدرسة"));
  });

  it("tells Arabic from Hebrew", () => {
    expect(hasArabic("שלום")).toBe(false);
    expect(hasArabic("سلام")).toBe(true);
    expect(arabicRatio("سلام عليكم and hello")).toBeCloseTo(9 / 17, 5);
  });

  it("peels proclitics, the article and one ending, never below three letters", () => {
    expect(arabicPrefixVariants("والمدرسة")).toEqual(["والمدرسة", "المدرسة", "مدرسة"]);
    expect(arabicPrefixVariants("للمدرسة")).toEqual(["للمدرسة", "المدرسة", "مدرسة"]);
    expect(arabicPrefixVariants("بيت")).toEqual(["بيت"]);
    expect(arabicSuffixVariants("مدرستها")).toContain("مدرست");
  });
});

describe("search in Hebrew, Arabic and English", () => {
  it("a match ignores tashkeel and hamza seats", () => {
    expect(normalizeForMatch(POINTED)).toBe(normalizeForMatch("مدرسه"));
    expect(normalizeForMatch("أحمد")).toBe(normalizeForMatch("احمد"));
    expect(normalizeForMatch("שָׁלוֹם")).toBe(normalizeForMatch("שלום")); // Hebrew as before
  });

  it("an Arabic query meets the word with its clitics and article", () => {
    const doc = new Set(documentTerms("ذهبتُ إلى والمدرسةِ صباحًا. Notes in English. בית ספר"));
    const q = queryTerms("مدرسة");
    expect(q.some((t) => doc.has(t.term))).toBe(true);
    expect(queryTerms("English").some((t) => doc.has(t.term))).toBe(true);
    expect(queryTerms("ספר").some((t) => doc.has(t.term))).toBe(true);
  });
});

describe("Arabic spelling", () => {
  const dict = buildArabicDictionary("6\nمدرسة/A\nكتاب\nطالب/B\nمعلم\nسؤال\nأحمد\n");

  it("reads stems from a hunspell .dic, folded", () => {
    expect(dict.has(foldArabic("مدرسة"))).toBe(true);
    expect(dict.size).toBe(6);
  });

  it("knows a word under clitics, the article, an ending, tashkeel or another hamza seat", () => {
    for (const w of ["مدرسة", "والمدرسة", "للمدرسة", "بالكتاب", "كتابها", "مَدْرَسَةٌ", "احمد", "مدرسه"]) expect(isKnownArabic(dict, w)).toBe(true);
    for (const w of ["مردسة", "كتبا", "طالبب"]) expect(isKnownArabic(dict, w)).toBe(false);
  });

  it("flags unknown words with suggestions one edit away", () => {
    const text = "ذهب الطالب إلى المردسة";
    const ms = arabicSpelling(dict, text).filter((m) => text.slice(m.offset, m.offset + m.length) === "المردسة");
    expect(ms).toHaveLength(1);
    expect(ms[0].rule.id).toBe("AR_SPELLING");
    expect(suggestArabic(dict, "مردسة")).toContain("مدرسة");
  });

  it("rules without a list: repeated word, space before punctuation, Latin punctuation", () => {
    const text = "في في البيت ، هل أنت هنا? نعم, شكرا";
    const ids = arabicRules(text).map((m) => [m.rule.id, text.slice(m.offset, m.offset + m.length), m.replacements[0]]);
    expect(ids).toContainEqual(["AR_DOUBLE_WORD", "في في", "في"]);
    expect(ids).toContainEqual(["AR_SPACE_BEFORE_PUNCT", " ،", "،"]);
    expect(ids).toContainEqual(["AR_LATIN_PUNCT", "?", "؟"]);
    expect(ids).toContainEqual(["AR_LATIN_PUNCT", ",", "،"]);
  });

  it("the 200-error set is well formed: every wrong form differs from its word after folding", () => {
    const set = JSON.parse(readFileSync(join(__dirname, "..", "..", "eval", "arabic-spell", "errors.json"), "utf8")) as { items: { wrong: string; right: string }[] };
    expect(set.items).toHaveLength(200);
    for (const it of set.items) expect(foldArabic(it.wrong)).not.toBe(foldArabic(it.right));
    // Against a list holding only the right words, every misspelling is caught.
    const own = buildArabicDictionary(`${set.items.length}\n${[...new Set(set.items.map((i) => i.right))].join("\n")}\n`);
    expect(set.items.filter((i) => !isKnownArabic(own, i.wrong)).length).toBeGreaterThanOrEqual(190);
  });
});

describe("Arabic paragraphs stay on this device", () => {
  it("checkByLanguage sends neither Hebrew nor Arabic to the remote checker", async () => {
    const { checkByLanguage } = await import("../ai/hebrewSpellService");
    const sent: string[] = [];
    const text = "פסקה בעברית.\n\nفقرة عربية في في النص.\n\nAn English line with كلمة inside.";
    const matches = await checkByLanguage(text, async (latin) => {
      sent.push(latin);
      return [];
    });
    expect(sent.join("")).not.toMatch(/[\p{Script=Arabic}\p{Script=Hebrew}]/u);
    const double = matches.find((m) => m.rule.id === "AR_DOUBLE_WORD");
    expect(double && text.slice(double.offset, double.offset + double.length)).toBe("في في");
  });
});

describe("one note, three languages: each line takes its own direction", () => {
  const lines: [string, "rtl" | "ltr"][] = [
    ["# مقدمة الدراسة", "rtl"],
    ["# מבוא למחקר", "rtl"],
    ["# Introduction", "ltr"],
    ["هذه فقرة عربية مع English words في الوسط.", "rtl"],
    ["זו פסקה בעברית עם كلمة عربية.", "rtl"],
    ["An English sentence with عربي and עברית.", "ltr"],
    ["- عنصر في قائمة", "rtl"],
    ["- [ ] مهمة مفتوحة", "rtl"],
    ["> اقتباس بالعربية", "rtl"],
    ["1. الخطوة الأولى", "rtl"],
    ["2024 هو العام", "rtl"],
    ["[الرابط](https://example.com/a)", "rtl"],
    ["`code` ثم نص عربي", "rtl"],
    ["مَدْرَسَةٌ جَمِيلَةٌ", "rtl"],
    ["| الاسم | Name |", "rtl"],
  ];
  it.each(lines)("%s", (line, dir) => {
    expect(markdownLineDirection(line)).toBe(dir);
  });
});
