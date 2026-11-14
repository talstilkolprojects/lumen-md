/**
 * Plan W5.19 — "Your morning" in today's daily note: changes since the last
 * morning, the tasks due, the cards to review, the Hebrew date, parasha and
 * holidays; every row links to its source; a 10,000-note vault in ≤ 2 s;
 * nothing sent; off by default.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { END, morningData, renderMorning, START, tasksDue, upsertMorning, type MorningNote, type MorningWords } from "../daily/morningCore";
import { DEFAULT_DAILY } from "../daily/defaults";
import { hebrewDate } from "../daily/dailyNote";
import { weeklyReading } from "../daily/hebrewCalendar";
import { readingName } from "../daily/hebrewCalendarNames";

const W: MorningWords = {
  title: "Your morning",
  changed: "Changed",
  noChanges: "Nothing changed.",
  tasks: "Tasks",
  noTasks: "No task.",
  overdue: (d) => `due ${d}`,
  review: (n) => `Cards: ${n}`,
  noReview: "Nothing to review.",
  openReview: "Open review",
  more: (n) => `and ${n} more`,
  holidays: "Today",
};
const T0 = Date.UTC(2026, 10, 12, 6);
const notes: MorningNote[] = [
  { path: "projects/plan.md", modified: T0 - 3_600_000, content: "# Plan\n- [ ] send the draft 📅 2026-11-12\n- [x] done 📅 2026-11-12\n- [ ] later 📅 2026-12-01" },
  { path: "inbox.md", modified: T0 - 2 * 86_400_000, content: "- [ ] call the bank [due:: 2026-11-10]\n```\n- [ ] in code 📅 2026-11-12\n```" },
  { path: "journal/2026-11-11.md", modified: T0 - 600_000, content: "- [ ] yesterday's @due(2026-11-11)" },
  { path: "ideas/[[odd]] name.md", modified: T0 - 60_000, content: "no tasks" },
];
const input = (over = {}) => ({
  date: "2026-11-12",
  hebrewDate: "א׳ בכסלו תשפ״ז",
  parasha: "פרשת תולדות",
  holidays: ["ראש חודש כסלו"],
  notes,
  since: T0 - 86_400_000,
  skip: (p: string) => p.startsWith("journal/"),
  cardsDue: 2,
  cards: [{ front: "What is FSRS?", link: "[[notes/srs#^q1]]" }],
  ...over,
});

describe("data", () => {
  it("tasks due today or overdue, in three date syntaxes, not done, not later, not in code", () => {
    expect(tasksDue(notes, "2026-11-12").map((t) => `${t.path}:${t.line} ${t.text} ${t.due}`)).toEqual([
      "inbox.md:1 call the bank 2026-11-10",
      "journal/2026-11-11.md:1 yesterday's 2026-11-11",
      "projects/plan.md:2 send the draft 2026-11-12",
    ]);
  });

  it("changes since the last morning, newest first, without daily notes", () => {
    const d = morningData(input());
    expect(d.changed.map((c) => c.path)).toEqual(["ideas/[[odd]] name.md", "projects/plan.md"]);
  });
});

describe("the block", () => {
  const block = renderMorning(morningData(input()), W);

  it("has the date, parasha and holiday, and every row links to its source", () => {
    expect(block.startsWith(START) && block.endsWith(END)).toBe(true);
    expect(block).toContain("**א׳ בכסלו תשפ״ז** · פרשת תולדות · Today: ראש חודש כסלו");
    const rows = block.split("\n").filter((l) => l.startsWith("- "));
    const informational = new Set(["- Open review"]);
    for (const r of rows) if (!informational.has(r)) expect(r, r).toMatch(/\[\[[^\]]+\]\]/);
    expect(block).toContain("- call the bank — [[inbox|inbox]] (due 2026-11-10)");
    expect(block).toContain("- What is FSRS? — [[notes/srs#^q1]]");
    // A path with brackets cannot break the link.
    expect(block).toContain("[[ideas/[[odd]] name|");
  });

  it("empty sections say so", () => {
    const b = renderMorning(morningData(input({ notes: [], cardsDue: 0, cards: [] })), W);
    expect(b).toContain("- Nothing changed.");
    expect(b).toContain("- No task.");
    expect(b).toContain("- Nothing to review.");
  });

  it("replaces the previous block in place and leaves the note's own text", () => {
    const note = "# Thursday\n\nweekday line\n\nMy own notes.";
    const once = upsertMorning(note, block);
    expect(once.startsWith("# Thursday\n\n" + START)).toBe(true);
    expect(once).toContain("My own notes.");
    const again = upsertMorning(once, renderMorning(morningData(input({ cardsDue: 0, cards: [] })), W));
    expect(again.split(START)).toHaveLength(2);
    expect(again).toContain("Nothing to review.");
    expect(again).toContain("My own notes.");
  });
});

describe("the calendar line is the real one", () => {
  it("12 Nov 2026 is 2 Kislev 5787, parasha Toldot", () => {
    expect(hebrewDate({ y: 2026, m: 11, d: 12 })).toMatch(/כסלו/);
    expect(readingName(weeklyReading({ y: 2026, m: 11, d: 12 }, { israel: true }), "he")).toBe("פרשת תולדות");
  });
});

describe("budget and privacy", () => {
  it("a 10,000-note vault: the block in ≤ 2 s, no request", () => {
    const big: MorningNote[] = Array.from({ length: 10_000 }, (_, i) => ({
      path: `notes/${Math.floor(i / 500)}/n${i}.md`,
      modified: T0 - (i % 1000) * 3_600_000,
      content: `# Note ${i}\n\n${"Some text about the topic. ".repeat(40)}\n${i % 25 === 0 ? `- [ ] task ${i} 📅 2026-11-${String((i % 12) + 1).padStart(2, "0")}\n` : ""}- [x] done`,
    }));
    const calls: string[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (u: string) => (calls.push(String(u)), new Response(""))) as typeof fetch;
    try {
      const t0 = performance.now();
      const b = renderMorning(morningData(input({ notes: big })), W);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(2000);
      expect(b).toContain("and ");
    } finally {
      globalThis.fetch = saved;
    }
    expect(calls).toEqual([]);
  });

  it("off by default", () => {
    expect(DEFAULT_DAILY.morning).toBeUndefined();
  });

  it("its English is lazy: not in the startup bundle, imported by its strings module only", () => {
    const SRC = resolve(__dirname, "..");
    const lazy = JSON.parse(readFileSync(join(SRC, "i18n/lazy/morning.json"), "utf8")) as Record<string, string>;
    const index = readFileSync(join(SRC, "i18n/index.ts"), "utf8");
    for (const k of Object.keys(lazy)) {
      expect(k.startsWith("morning."), k).toBe(true);
      expect(index.includes(`"${k}":`), k).toBe(false);
    }
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "__tests__" ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
    expect(walk(SRC).filter((f) => readFileSync(f, "utf8").includes("i18n/lazy/morning.json")).map((f) => f.slice(SRC.length + 1))).toEqual(["daily/morningStrings.ts"]);
  });
});
