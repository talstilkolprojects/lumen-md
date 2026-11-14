/**
 * Automatic Hebrew typography (plan W2.9): 50 golden cases, nothing inside
 * code, links or the frontmatter changes, and each rule can be turned off.
 */
import { describe, it, expect } from "vitest";
import { applyEdits, editsForKeystroke, hebrewTypography, protectedRanges, RLM, typographyEdits, TYPO_RULES, type TypoRule } from "../text/hebrewTypography";

/** [what was typed, what it becomes with every rule on]. */
const GOLDEN: Array<[string, string]> = [
  // gershayim
  ['צה"ל', "צה״ל"],
  ['ת"א', "ת״א"],
  ['ארה"ב היא מדינה', "ארה״ב היא מדינה"],
  ['בס"ד', "בס״ד"],
  ['מנכ"ל החברה', "מנכ״ל החברה"],
  ['דו"ח שנתי', "דו״ח שנתי"],
  ['עו"ד כהן', "עו״ד כהן"],
  ['ש"ח', "ש״ח"],
  // geresh
  ["ג'ירפה", "ג׳ירפה"],
  ["צ'יפס", "צ׳יפס"],
  ["ז'קט", "ז׳קט"],
  ["פרק ג'", "פרק ג׳"],
  ["ספט' 2026", "ספט׳ 2026"],
  ["ה' באייר", "ה׳ באייר"],
  ["ג'ונגל צ'ילה", "ג׳ונגל צ׳ילה"],
  // quotes
  ['הוא אמר "שלום" ויצא', "הוא אמר „שלום” ויצא"],
  ['"בוקר טוב"', "„בוקר טוב”"],
  ['היא כתבה "תודה."', "היא כתבה „תודה.”"],
  ['("ציטוט")', "(„ציטוט”)"],
  ['המילה "ספר", והמילה "עט"', "המילה „ספר”, והמילה „עט”"],
  ["'שלום' אמר", "'שלום' אמר"],
  // maqaf
  ["בית-ספר", "בית־ספר"],
  ["תל-אביב", "תל־אביב"],
  ["דו-שיח", "דו־שיח"],
  ["רב-תכליתי", "רב־תכליתי"],
  ["ב-2026", "ב-2026"],
  ["ל-HTML", "ל-HTML"],
  // dash
  ["אחד - שניים", "אחד – שניים"],
  ["הבעיה, - והפתרון", "הבעיה, – והפתרון"],
  ["word - word", "word - word"],
  // numbers
  ["הנחה של 50 %", "הנחה של 50%"],
  ["הנחה של %50 היום", "הנחה של 50% היום"],
  ["עמודים 10–20", "עמודים 10-20"],
  ["בשנים 1990—2000", "בשנים 1990-2000"],
  ["discount 50 %", "discount 50 %"],
  ["בשעה 14:30", "בשעה 14:30"],
  ["ב-10/11/2026", "ב-10/11/2026"],
  // mixedLine
  ["HTML היא שפת סימון.", `${RLM}HTML היא שפת סימון.`],
  ["# Lumen הוא עורך!", `# ${RLM}Lumen הוא עורך!`],
  ["- iPhone זה טלפון.", `- ${RLM}iPhone זה טלפון.`],
  ["HTML is a markup language.", "HTML is a markup language."],
  ["שלום world.", "שלום world."],
  [`${RLM}HTML היא שפה.`, `${RLM}HTML היא שפה.`],
  // combined
  ['צה"ל ו"ההגנה" - סיפור', "צה״ל ו„ההגנה” – סיפור"],
  ["דו-שיח של 30 % מהזמן", "דו־שיח של 30% מהזמן"],
  // untouched
  ["שלום עולם", "שלום עולם"],
  ['say "hello"', 'say "hello"'],
  ["it's fine", "it's fine"],
  ["", ""],
  ["1-2-3", "1-2-3"],
];

describe("Hebrew typography (W2.9)", () => {
  it("50 golden cases", () => {
    expect(GOLDEN).toHaveLength(50);
    const wrong = GOLDEN.filter(([a, b]) => hebrewTypography(a) !== b).map(([a, b]) => `${a} → ${hebrewTypography(a)} (want ${b})`);
    expect(wrong).toEqual([]);
  });

  it("is idempotent: a second pass changes nothing", () => {
    for (const [a] of GOLDEN) expect(hebrewTypography(hebrewTypography(a)), a).toBe(hebrewTypography(a));
  });

  it("never changes code, links, URLs, wiki-links, HTML, math or the frontmatter", () => {
    const doc = [
      "---",
      'title: צה"ל ו-בית-ספר',
      "---",
      "",
      "```js",
      'const s = "צה"ל"; // בית-ספר',
      "```",
      "",
      'טקסט `צה"ל - בית-ספר` וקישור [צה"ל](https://example.com/בית-ספר) ו-[[בית-ספר]].',
      "<span title=\"צה\"ל\">x</span> https://example.com/a-ב-ב $x-א-ב$",
      "",
      "$$",
      "א-ב",
      "$$",
      "",
      'ואחרי זה צה"ל.',
    ].join("\n");
    const out = hebrewTypography(doc);
    const guard = protectedRanges(doc);
    // Every protected range is byte for byte the same, and only the last line changed.
    const edits = typographyEdits(doc);
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) for (const [a, b] of guard) expect(e.from >= b || Math.max(e.to, e.from + 1) <= a, `${e.rule} at ${e.from}`).toBe(true);
    expect(out.split("\n").at(-1)).toBe("ואחרי זה צה״ל.");
    expect(out.split("\n").slice(0, 15)).toEqual(doc.split("\n").slice(0, 15));
  });

  it("each rule can be turned off on its own", () => {
    const text = 'צה"ל ג\'ירפה "שלום" בית-ספר אחד - שניים 50 % ';
    const all = hebrewTypography(text);
    for (const rule of TYPO_RULES) {
      const off = hebrewTypography(text, { [rule]: false } as Partial<Record<TypoRule, boolean>>);
      const edits = typographyEdits(text, { [rule]: false } as Partial<Record<TypoRule, boolean>>);
      expect(edits.some((e) => e.rule === rule), rule).toBe(false);
      if (typographyEdits(text).some((e) => e.rule === rule)) expect(off, rule).not.toBe(all);
    }
  });

  it("a code span still being typed is code too", () => {
    expect(hebrewTypography('טקסט `צה"ל')).toBe('טקסט `צה"ל');
    expect(hebrewTypography('`a` צה"ל')).toBe("`a` צה״ל");
  });

  it("within: only the edits touching what was just typed", () => {
    const text = 'צה"ל ועוד צה"ל';
    const last = typographyEdits(text, {}, { from: text.length - 2, to: text.length });
    expect(last).toHaveLength(1);
    expect(applyEdits(text, last)).toBe('צה"ל ועוד צה״ל');
  });
});

/** Type `s` one character at a time, fixing what each keystroke completes (as the editor does). */
function typeOut(s: string): string {
  let text = "";
  for (const ch of s) {
    text += ch;
    const head = text.length;
    const lineStart = text.lastIndexOf("\n", head - 1) + 1;
    const edits = editsForKeystroke(typographyEdits(text, {}, { from: lineStart, to: head }), head, ch, head);
    text = applyEdits(text, edits);
  }
  return text;
}

describe("as you type (W2.9)", () => {
  const cases: Array<[string, string]> = [
    ['צה"ל', "צה״ל"],
    ["ג'ירפה", "ג׳ירפה"],
    ['הוא אמר "שלום" ויצא', "הוא אמר „שלום” ויצא"],
    ["בית-ספר", "בית־ספר"],
    ["אחד - שניים", "אחד – שניים"],
    ["הנחה של 50 % היום", "הנחה של 50% היום"],
    ["הנחה של %50 היום", "הנחה של 50% היום"],
    ["עמודים 10–20", "עמודים 10-20"],
    ["HTML היא שפת סימון.", `${RLM}HTML היא שפת סימון.`],
    ["say \"hello\" it's", "say \"hello\" it's"],
  ];
  it.each(cases)("%s", (typed, want) => {
    expect(typeOut(typed)).toBe(want);
  });

  it("a fix that was undone is not redone by the next keystrokes", () => {
    // After צה״ל, Ctrl+Z gives back צה"ל; typing on must leave the " alone.
    let text = 'צה"ל';
    for (const ch of " הוא צבא") {
      text += ch;
      const head = text.length;
      text = applyEdits(text, editsForKeystroke(typographyEdits(text, {}, { from: 0, to: head }), head, ch, head));
    }
    expect(text).toBe('צה"ל הוא צבא');
  });
});
