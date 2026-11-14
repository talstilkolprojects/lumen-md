/**
 * W3.11 — suggestions by author (accept / reject only one person's, the AI
 * as an author) and named versions compared word by word, with 20 Hebrew
 * golden cases for the comparison.
 */
import { describe, expect, it } from "vitest";
import { AI_AUTHOR, authorHue, resolveByAuthor, suggestionAuthors } from "../editor/suggestAuthors";
import { wordDiff, wordTokens } from "../collab/wordDiff";
import { addVersion, cleanVersionName, compareVersions, listVersions, type VersionList } from "../collab/namedVersions";

const show = (older: string, newer: string) =>
  wordDiff(older, newer)
    .map((o) => (o.type === "equal" ? "" : o.type === "insert" ? "+" : "-") + `[${o.text}]`)
    .join("");

describe("suggestions by author", () => {
  const doc = "Hello {++dear ++}{>>@Dana<<}world{--, old--}{>>@Avi<<}. {~~cat~>dog~~}{>>@Dana<<} {++כן++}{>>@AI<<} {++anon++}";

  it("lists the authors, AI flagged, most suggestions first", () => {
    expect(suggestionAuthors(doc)).toEqual([
      { author: "Dana", count: 2, ai: false },
      { author: "AI", count: 1, ai: true },
      { author: "Avi", count: 1, ai: false },
      { author: null, count: 1, ai: false },
    ]);
  });

  it("accepting one author's suggestions applies only theirs", () => {
    expect(resolveByAuthor(doc, "Dana", "accept")).toBe("Hello dear world{--, old--}{>>@Avi<<}. dog {++כן++}{>>@AI<<} {++anon++}");
  });

  it("rejecting one author's suggestions removes only theirs", () => {
    expect(resolveByAuthor(doc, "Avi", "reject")).toBe("Hello {++dear ++}{>>@Dana<<}world, old. {~~cat~>dog~~}{>>@Dana<<} {++כן++}{>>@AI<<} {++anon++}");
    expect(resolveByAuthor(doc, AI_AUTHOR, "reject")).toBe("Hello {++dear ++}{>>@Dana<<}world{--, old--}{>>@Avi<<}. {~~cat~>dog~~}{>>@Dana<<}  {++anon++}");
    expect(resolveByAuthor(doc, null, "accept")).toBe("Hello {++dear ++}{>>@Dana<<}world{--, old--}{>>@Avi<<}. {~~cat~>dog~~}{>>@Dana<<} {++כן++}{>>@AI<<} anon");
  });

  it("gives each author a stable colour, the AI its own", () => {
    expect(authorHue("Dana")).toBe(authorHue("Dana"));
    expect(authorHue("AI")).toBe(280);
  });
});

describe("word tokens", () => {
  it("keeps Hebrew prefixes, niqqud and geresh inside the word", () => {
    expect(wordTokens("ובבית שָׁלוֹם, צה״ל ג'ירפה.")).toEqual(["ובבית", " ", "שָׁלוֹם", ",", " ", "צה״ל", " ", "ג'ירפה", "."]);
  });
});

/** 20 golden comparisons, Hebrew first: [older, newer, expected]. */
const GOLDEN: [string, string, string][] = [
  ["שלום עולם", "שלום עולם", "[שלום עולם]"],
  ["הבית גדול", "ובית גדול", "-[הבית]+[ובית][ גדול]"],
  ["הילד הלך לבית הספר", "הילד רץ לבית הספר", "[הילד ]-[הלך]+[רץ][ לבית הספר]"],
  ["אני אוהב קפה", "אני אוהב קפה שחור", "[אני אוהב קפה]+[ שחור]"],
  ["אני אוהב קפה שחור", "אני אוהב קפה", "[אני אוהב קפה]-[ שחור]"],
  ["פגישה ביום שני", "פגישה ביום שלישי בבוקר", "[פגישה ביום ]-[שני]+[שלישי בבוקר]"],
  ["שָׁלוֹם לכם", "שלום לכם", "-[שָׁלוֹם]+[שלום][ לכם]"],
  ["צה״ל הודיע", "צה\"ל הודיע", "-[צה״ל]+[צה\"ל][ הודיע]"],
  ["המחיר 100 ש\"ח", "המחיר 120 ש\"ח", "[המחיר ]-[100]+[120][ ש\"ח]"],
  ["השתמשו ב-Lumen כל יום", "השתמשו ב-Lumen כל שבוע", "[השתמשו ב-Lumen כל ]-[יום]+[שבוע]"],
  ["כתבנו את זה ב-2025.", "כתבנו את זה ב-2026.", "[כתבנו את זה ב-]-[2025]+[2026][.]"],
  ["א, ב, ג", "א, ג", "[א, ]-[ב, ][ג]"],
  ["הטקסט הזה ישן", "טקסט חדש לגמרי", "-[הטקסט הזה ישן]+[טקסט חדש לגמרי]"],
  ["שורה ראשונה\nשורה שנייה", "שורה ראשונה\nשורה שלישית", "[שורה ראשונה\nשורה ]-[שנייה]+[שלישית]"],
  ["", "טקסט חדש", "+[טקסט חדש]"],
  ["טקסט ישן", "", "-[טקסט ישן]"],
  ["מה שלומך?", "מה שלומך!", "[מה שלומך]-[?]+[!]"],
  ["ספר (חדש) על היסטוריה", "ספר (ישן) על היסטוריה", "[ספר (]-[חדש]+[ישן][) על היסטוריה]"],
  ["לקוח: דנה כהן", "לקוחה: דנה לוי", "-[לקוח]+[לקוחה][: דנה ]-[כהן]+[לוי]"],
  ["- פריט א\n- פריט ב", "- פריט א\n- פריט ב\n- פריט ג", "[- פריט א\n- פריט ב]+[\n- פריט ג]"],
];

describe("word-level comparison (20 Hebrew golden cases)", () => {
  it("has 20 cases", () => expect(GOLDEN.length).toBe(20));
  GOLDEN.forEach(([a, b, want], i) => {
    it(`case ${i + 1}: ${JSON.stringify(a).slice(0, 24)} → ${JSON.stringify(b).slice(0, 24)}`, () => {
      expect(show(a, b)).toBe(want);
    });
  });
});

function fakeList(): VersionList & { items: unknown[] } {
  const items: unknown[] = [];
  return { items, toArray: () => items, push: (xs) => void items.push(...xs), observe: () => {}, unobserve: () => {} };
}

describe("named versions", () => {
  it("saves, lists newest first, and skips malformed entries", () => {
    const list = fakeList();
    expect(addVersion(list, "  לפני   הגשה ", "v1", "Dana", 1000)?.name).toBe("לפני הגשה");
    addVersion(list, "Draft 2", "v2", null, 2000);
    list.items.push({ id: 1, name: "bad" }, null);
    expect(listVersions(list).map((v) => v.name)).toEqual(["Draft 2", "לפני הגשה"]);
    expect(addVersion(list, "   ", "x", null)).toBe(null);
  });

  it("cleans names of control and direction characters, and caps the length", () => {
    expect(cleanVersionName("a\u202Eb\u0007c")).toBe("abc");
    expect(cleanVersionName("x".repeat(200)).length).toBe(80);
  });

  it("compares two versions with word counts", () => {
    const c = compareVersions("הילד הלך לבית הספר", "הילד רץ מהר לבית הספר");
    expect(c.added).toBe(2);
    expect(c.removed).toBe(1);
  });
});
