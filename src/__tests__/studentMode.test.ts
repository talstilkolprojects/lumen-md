/**
 * Plan W5.13 — student mode: Whisper windows on the recording's clock,
 * sentences each with a ▶, the "important!" taps, a summary copied from the
 * transcript, cloze cards that W3.3's review reads as `front :: back` and
 * that each link to their moment, and the lecture note.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { segmentsOf } from "../ai/timedSegments";
import { cardsFrom, clock, clozeCard, extractiveSummary, importantOf, lectureNote, playLink, sentencesOf, verifySummary, type Lecture } from "../student/lectureCore";
import { lecturePaths } from "../student/lecture";

/** W3.3's card line (src/srs/cards.ts qaCards on feat/spaced-review): `front :: back`, a front with a space or a question mark. */
const QA = /^\s*(?:[-*+]\s+)?(.+?)\s*::\s*(.+?)\s*$/;
const isCard = (line: string) => {
  const m = QA.exec(line);
  return !!m && m[2].trim() !== "" && m[1].length >= 3 && (/\s/.test(m[1]) || /[?？؟]$/.test(m[1]));
};

const segments = [
  { start: 0, end: 12, text: "שלום לכולם. היום נדבר על מיטוזה ומיוזה." },
  { start: 12, end: 30, text: "במיטוזה תא אחד מתחלק לשני תאים זהים. זה חשוב מאוד למבחן." },
  { start: 30, end: 48, text: "במיוזה נוצרים ארבעה תאים עם חצי ממספר הכרומוזומים. מיוזה מתרחשת בתאי מין." },
  { start: 48, end: 60, text: "בשבוע הבא נדבר על DNA." },
];

describe("timing", () => {
  it("Whisper chunks of a later window land on the recording's clock", () => {
    expect(segmentsOf({ text: "a b", chunks: [{ timestamp: [0, 4.2], text: " first " }, { timestamp: [4.2, null], text: "second" }] }, 30, 28.5)).toEqual([
      { start: 30, end: 34.2, text: "first" },
      { start: 34.2, end: 58.5, text: "second" },
    ]);
    // No chunk timestamps: the window is one segment.
    expect(segmentsOf({ text: " whole window " }, 60, 30)).toEqual([{ start: 60, end: 90, text: "whole window" }]);
    expect(segmentsOf({ text: "  " }, 0, 30)).toEqual([]);
  });

  it("each sentence gets its share of its segment's time, in order", () => {
    const s = sentencesOf(segments);
    expect(s.map((x) => x.text)).toEqual(["שלום לכולם.", "היום נדבר על מיטוזה ומיוזה.", "במיטוזה תא אחד מתחלק לשני תאים זהים.", "זה חשוב מאוד למבחן.", "במיוזה נוצרים ארבעה תאים עם חצי ממספר הכרומוזומים.", "מיוזה מתרחשת בתאי מין.", "בשבוע הבא נדבר על DNA."]);
    for (let i = 1; i < s.length; i++) expect(s[i].start).toBeGreaterThanOrEqual(s[i - 1].start);
    expect(s[0].start).toBe(0);
    expect(s[s.length - 1].end).toBe(60);
  });

  it("clock and ▶ links (media fragments)", () => {
    expect([clock(0), clock(75.9), clock(3725)]).toEqual(["0:00", "1:15", "1:02:05"]);
    expect(playLink("audio/l.webm", { start: 75.4, end: 80.2, text: "" })).toBe("[▶ 1:15](<audio/l.webm#t=75,81>)");
  });
});

describe("important moments, summary, cards", () => {
  const s = sentencesOf(segments);

  it("a tap marks what was just said (20 s before, 5 s after)", () => {
    const imp = importantOf(s, [29]);
    expect([...imp].map((i) => s[i].text)).toContain("זה חשוב מאוד למבחן.");
    expect([...imp].map((i) => s[i].text)).not.toContain("בשבוע הבא נדבר על DNA.");
  });

  it("the summary is sentences of the transcript, the marked ones in it, in spoken order", () => {
    const imp = importantOf(s, [40]);
    const sum = extractiveSummary(s, imp, 3);
    expect(sum).toEqual([...sum].sort((a, b) => a - b));
    for (const i of imp) expect(sum.length < 3 || sum.includes(i) || imp.size > 3).toBe(true);
    expect(verifySummary(sum.map((i) => s[i].text), s.map((x) => x.text).join(" "))).toBe(true);
    expect(verifySummary(["משפט שלא נאמר."], s.map((x) => x.text).join(" "))).toBe(false);
  });

  it("cloze cards from the marked sentences, each linked to its moment, readable by the review queue", () => {
    const imp = importantOf(s, [40]);
    const cards = cardsFrom(s, imp, "audio/l.webm");
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.front).toContain("____");
      expect(c.back).toMatch(/\[▶ \d+:\d{2}\]\(<audio\/l\.webm#t=\d+,\d+>\)/);
      expect(isCard(`- ${c.front} :: ${c.back}`)).toBe(true);
    }
    expect(clozeCard({ start: 0, end: 1, text: "כן." }, "a.webm")).toBeNull();
  });
});

describe("the lecture note", () => {
  const s = sentencesOf([...segments, { start: 60, end: 62, text: "רשמו: A :: B." }]);
  const important = importantOf(s, [40]);
  const lecture: Lecture = { title: "ביולוגיה 3", date: "2026-11-12", audioPath: "audio/l.webm", durationSec: 62, sentences: s, important, summary: extractiveSummary(s, important), cards: cardsFrom(s, important, "audio/l.webm") };
  const note = lectureNote(lecture, { recording: "Recording", summary: "Summary", cards: "Cards", noCards: "No cards", transcript: "Transcript", important: "Important" });

  it("has every sentence with its ▶, the marked ones starred", () => {
    const transcript = note.split("## Transcript")[1];
    for (const x of s) expect(transcript).toContain(x.text.replace(/::/g, ":"));
    expect(transcript.split("\n").filter((l) => l.startsWith("[▶ ")).length).toBe(s.length);
    expect(transcript).toContain("**⭐ Important**");
  });

  it("only the Cards section holds cards: a spoken '::' does not become one", () => {
    const [before, rest] = note.split("## Cards");
    const [cardsPart, after] = rest.split("## Transcript");
    expect(before.split("\n").filter(isCard)).toEqual([]);
    expect(after.split("\n").filter(isCard)).toEqual([]);
    expect(cardsPart.split("\n").filter(isCard).length).toBe(lecture.cards.length);
  });

  it("paths: the note in Lectures/, its audio beside it", () => {
    expect(lecturePaths(new Date(2026, 10, 12, 9, 5), "ביולוגיה: 3/4", "audio/webm;codecs=opus")).toEqual({
      note: "Lectures/2026-11-12 0905 ביולוגיה 3 4.md",
      audio: "Lectures/audio/lecture-2026-11-12-0905.webm",
      audioLink: "audio/lecture-2026-11-12-0905.webm",
    });
  });
});

describe("strings", () => {
  it("student mode's English is lazy: not in the startup bundle, imported by its strings module only", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const SRC = resolve(__dirname, "..");
    const lazy = JSON.parse(readFileSync(join(SRC, "i18n/lazy/student.json"), "utf8")) as Record<string, string>;
    const index = readFileSync(join(SRC, "i18n/index.ts"), "utf8");
    for (const k of Object.keys(lazy)) {
      expect(k.startsWith("student."), k).toBe(true);
      expect(index.includes(`"${k}":`), k).toBe(false);
    }
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "__tests__" ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
    expect(walk(SRC).filter((f) => readFileSync(f, "utf8").includes("i18n/lazy/student.json")).map((f) => f.slice(SRC.length + 1))).toEqual(["student/strings.ts"]);
  });
});
