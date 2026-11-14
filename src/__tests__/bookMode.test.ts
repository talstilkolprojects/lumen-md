/**
 * Book-writing mode (plan W5.8): Hebrew word count, the Longform index
 * (read, reorder, add), progress against goals, the daily streak, and a
 * 30-chapter book assembled well under 10 s.
 */
import { describe, it, expect } from "vitest";
import { addChapter, bookProgress, chapterTitle, dailyProgress, logPathFor, moveChapter, newBookIndex, parseBookIndex, recordWords, wordsOn, type WordLog } from "../book/book";
import { countWords, proseOf } from "../book/wordCount";

describe("Hebrew word count (W5.8)", () => {
  const cases: Array<[string, number]> = [
    ["שלום עולם", 2],
    // A prefix is part of its word, also when a hyphen or maqaf joins it to Latin or a number.
    ["וכשהבית נבנה ב-1948 על ידי ה-CNN", 6],
    ["ב־1948 ה־IDF", 2],
    // Abbreviations with gershayim / geresh are one word; so is a maqaf compound.
    ["צה״ל ות\"א ומס׳ בית־ספר", 4],
    // Niqqud does not split a word.
    ["בְּרֵאשִׁית בָּרָא", 2],
    // A spaced dash is not a word.
    ["כן – לא - אולי", 3],
    ["3.14 ו-1,000 שקלים", 3],
    ["English and עברית mixed", 4],
  ];
  for (const [text, n] of cases) it(`${JSON.stringify(text)} → ${n}`, () => expect(countWords(text)).toBe(n));

  it("counts prose only: no frontmatter, code, comments, link targets, embeds or callout markers", () => {
    const md = [
      "---",
      "title: לא נספר",
      "word-goal: 1000",
      "---",
      "# פרק ראשון",
      "",
      "> [!note] הערה חשובה",
      "> גוף ההערה",
      "",
      "טקסט %% הערה נסתרת %% עם [[קישור|כינוי]] ו-[טקסט](https://example.com/a-b-c) ![[תמונה.png]] `קוד`",
      "",
      "```js",
      "const notCounted = 1;",
      "```",
      "<!-- גם זה לא -->",
      "שורה אחרונה ^block-1",
    ].join("\n");
    // פרק ראשון (2) הערה חשובה (2) גוף ההערה (2) טקסט עם כינוי ו-טקסט (4) שורה אחרונה (2)
    expect(countWords(md)).toBe(12);
    expect(proseOf(md)).not.toContain("notCounted");
  });
});

const index = newBookIndex({ title: "הספר", chapters: ["פתיחה", "השני", "השלישי"], lang: "he", wordGoal: 3000, dailyGoal: 100 });

describe("the book index: the Longform format (W5.8)", () => {
  it("writes and reads an index", () => {
    const book = parseBookIndex("Books/הספר/הספר.md", index);
    expect(book).toMatchObject({ title: "הספר", lang: "he", wordGoal: 3000, dailyGoal: 100 });
    expect(book!.chapters.map((c) => c.path)).toEqual(["Books/הספר/פתיחה.md", "Books/הספר/השני.md", "Books/הספר/השלישי.md"]);
    expect(index).toMatch(/^---\nlongform:\n {2}format: scenes\n/);
  });

  it("reads a Longform index as Longform writes it: nested scenes, a scene folder", () => {
    const lf = "---\nlongform:\n  format: scenes\n  title: Novel\n  workflow: Default Workflow\n  sceneFolder: scenes\n  scenes:\n    - one\n    - - one-a\n      - one-b\n    - two\n  ignoredFiles: []\n---\n";
    const book = parseBookIndex("Novel/Index.md", lf)!;
    expect(book.chapters.map((c) => [c.path, c.depth])).toEqual([
      ["Novel/scenes/one.md", 0],
      ["Novel/scenes/one-a.md", 1],
      ["Novel/scenes/one-b.md", 1],
      ["Novel/scenes/two.md", 0],
    ]);
    // A part moves with its chapter, and only `scenes:` changes.
    const moved = moveChapter(lf, 0, 1);
    expect(parseBookIndex("Novel/Index.md", moved)!.chapters.map((c) => c.name)).toEqual(["two", "one", "one-a", "one-b"]);
    expect(moved.replace(/ {2}scenes:[\s\S]*? {2}ignoredFiles/, "")).toBe(lf.replace(/ {2}scenes:[\s\S]*? {2}ignoredFiles/, ""));
  });

  it("is not a book without longform:, or with another Longform format", () => {
    expect(parseBookIndex("a.md", "---\ntitle: x\n---\n")).toBeNull();
    expect(parseBookIndex("a.md", "---\nlongform:\n  format: single\n---\n")).toBeNull();
    expect(parseBookIndex("a.md", "no frontmatter")).toBeNull();
  });

  it("reorders, adds a chapter, keeps comments and CRLF", () => {
    const crlf = index.replace("  scenes:", "  # the order\n  scenes:").replace(/\n/g, "\r\n");
    const moved = moveChapter(crlf, 2, 0);
    expect(parseBookIndex("x.md", moved)!.chapters.map((c) => c.name)).toEqual(["השלישי", "פתיחה", "השני"]);
    expect(moved).toContain("  # the order\r\n");
    expect(moved.includes("\n") && !/[^\r]\n/.test(moved)).toBe(true);
    const added = addChapter(moved, "אפילוג");
    expect(parseBookIndex("x.md", added)!.chapters.map((c) => c.name)).toEqual(["השלישי", "פתיחה", "השני", "אפילוג"]);
    expect(() => moveChapter(index, 0, 9)).toThrow();
  });
});

describe("progress and goals (W5.8)", () => {
  const book = parseBookIndex("B/הספר.md", index)!;
  const notes: Record<string, string> = {
    "B/פתיחה.md": "---\nword-goal: 10\n---\n# ההתחלה\n\nאחת שתיים שלוש ארבע\n",
    "B/השני.md": "# פרק שני\n\nמילה\n",
  };
  it("counts each chapter and the book, against the goals; a missing chapter is reported", () => {
    const p = bookProgress(book, (path) => notes[path] ?? null);
    expect(p.chapters.map((c) => [c.title, c.words, c.goal])).toEqual([
      ["ההתחלה", 5, 10],
      ["פרק שני", 3, undefined],
      ["השלישי", null, undefined],
    ]);
    expect(p.words).toBe(8);
    expect(p.goal).toBe(3000);
    expect(p.share).toBeCloseTo(8 / 3000);
    expect(p.missing).toEqual(["B/השלישי.md"]);
    expect(chapterTitle("x", "---\ntitle: מהכותרת\n---\n# לא\n")).toBe("מהכותרת");
  });

  it("today's words and the streak, by the writer's local days", () => {
    const d = (s: string) => new Date(`${s}T20:00:00`);
    let log: WordLog = {};
    log = recordWords(log, 1000, d("2026-11-08"));
    log = recordWords(log, 1150, d("2026-11-09"));
    log = recordWords(log, 1260, d("2026-11-10"));
    log = recordWords(log, 1300, d("2026-11-11"));
    expect(wordsOn(log, "2026-11-10")).toBe(110);
    // 11.11: 40 words, under the goal; the streak so far is 9.11 and 10.11.
    expect(dailyProgress(log, d("2026-11-11"), 100)).toEqual({ today: 40, goal: 100, streak: 2 });
    log = recordWords(log, 1420, d("2026-11-11"));
    expect(dailyProgress(log, d("2026-11-11"), 100)).toEqual({ today: 160, goal: 100, streak: 3 });
    // A day with no writing breaks the streak.
    expect(dailyProgress(recordWords(log, 1600, d("2026-11-13")), d("2026-11-13"), 100).streak).toBe(1);
    expect(logPathFor("Books/הספר.md")).toBe("Books/.הספר.lumen-book.json");
  });

  it("a 30-chapter book (90,000 words) is counted in well under 10 s", () => {
    const para = "וכשהגיע הבוקר יצאה נועה אל השדה, ושם ראתה את ה-CNN מצלמים את צה״ל בתרגיל. ";
    const chapters = Array.from({ length: 30 }, (_, i) => `פרק ${i + 1}`);
    const big = parseBookIndex("B/ספר.md", newBookIndex({ title: "ספר", chapters }))!;
    const text = `# כותרת\n\n${para.repeat(200)}\n`;
    const start = performance.now();
    const p = bookProgress(big, () => text);
    const ms = performance.now() - start;
    expect(p.chapters).toHaveLength(30);
    expect(p.words).toBe(30 * (1 + 14 * 200));
    expect(ms).toBeLessThan(10_000);
  });
});

describe("what a chapter prints (W5.8)", () => {
  it("drops the frontmatter and the title heading, which the book prints once", async () => {
    const { chapterBody } = await import("../book/book");
    expect(chapterBody("---\nword-goal: 5\n---\n# פרק א\n\nטקסט\n")).toBe("\nטקסט\n");
    expect(chapterBody("טקסט בלי כותרת\n# כותרת בהמשך\n")).toBe("טקסט בלי כותרת\n# כותרת בהמשך\n");
  });
});
