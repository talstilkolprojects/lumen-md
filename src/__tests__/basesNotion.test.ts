/**
 * Plan W6.46 — Notion's formula functions in Bases: a golden set of formulas
 * as Notion users write them (examples from notion.com/help/formula-syntax
 * and Notion's formula 2.0 docs), with the value Notion documents, run
 * through Lumen's own path (a `.base` formula column over a note).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { basesFileFromText, parseBase, runBase } from "../views/bases/base";
import { NOTION_FUNCTIONS, dateBetween, hebrewDate, hebrewNumeral, isoWeek } from "../views/bases/notion";
import { toText } from "../views/bases/values";

const NOW = new Date("2026-11-12T09:30:00Z");

/** A task note with Notion-like properties. */
const TASK = `---
Name: כתיבת פרק 3
Status: In progress
Priority: 2
Estimate: 5
Due: 2026-11-20
Start: 2026-11-02
Tags: [writing, thesis]
Owner: Tal
Done: false
Project: "[[Thesis]]"
---
`;
const PROJECT = `---
Name: Thesis
Budget: 120
---
`;
const SUB = (n: number, est: number, done: boolean) => `---\nName: Sub ${n}\nEstimate: ${est}\nDone: ${done}\nParent: "[[Thesis]]"\n---\n`;

const files = [
  basesFileFromText("Tasks/Chapter 3.md", TASK),
  basesFileFromText("Projects/Thesis.md", PROJECT),
  basesFileFromText("Tasks/Sub 1.md", SUB(1, 3, true)),
  basesFileFromText("Tasks/Sub 2.md", SUB(2, 4, false)),
  basesFileFromText("Tasks/Sub 3.md", SUB(3, 8, true)),
];

/** [name, formula, file the row is, the value Notion gives]. */
const GOLDEN: Array<[string, string, string, unknown]> = [
  // Logic
  ["if", 'if(Done, "✅", "⏳")', "Tasks/Chapter 3.md", "⏳"],
  ["ifs", 'ifs(Priority == 1, "High", Priority == 2, "Medium", "Low")', "Tasks/Chapter 3.md", "Medium"],
  ["let", "let(x, Estimate * 2, x + 1)", "Tasks/Chapter 3.md", 11],
  ["lets", "lets(a, Estimate, b, Priority, a * b)", "Tasks/Chapter 3.md", 10],
  ["equal / unequal", 'equal(Status, "In progress") && unequal(Owner, "Dana")', "Tasks/Chapter 3.md", true],
  ["empty", "empty(Missing)", "Tasks/Chapter 3.md", true],
  ["prop", 'prop("Owner")', "Tasks/Chapter 3.md", "Tal"],
  // Text
  ["length", "length(Owner)", "Tasks/Chapter 3.md", 3],
  ["substring (Notion's own example)", 'substring("Dangerfield", 0, 6)', "Tasks/Chapter 3.md", "Danger"],
  ["contains", 'contains(Status, "progress")', "Tasks/Chapter 3.md", true],
  ["test", 'test("Thomas 123", "\\\\d+")', "Tasks/Chapter 3.md", true],
  ["match", 'match("Thomas 123 Frank 321", "\\\\d+")', "Tasks/Chapter 3.md", ["123", "321"]],
  ["replace: the first match", 'replace("Pogo Pogo", "Po", "Dog")', "Tasks/Chapter 3.md", "Doggo Pogo"],
  ["replaceAll", 'replaceAll("Dogs Dogs Dogs", "Dogs", "Cats")', "Tasks/Chapter 3.md", "Cats Cats Cats"],
  ["lower / upper", 'lower("ABC") + upper("def")', "Tasks/Chapter 3.md", "abcDEF"],
  ["split / join", 'join(split("a,b,c", ","), " · ")', "Tasks/Chapter 3.md", "a · b · c"],
  ["repeat", 'repeat("ab", 3)', "Tasks/Chapter 3.md", "ababab"],
  ["format", "format(Estimate) + \" h\"", "Tasks/Chapter 3.md", "5 h"],
  ["Hebrew text: length counts letters, not bytes", "length(Name)", "Tasks/Chapter 3.md", 11],
  ["Hebrew text: stripNikud", 'stripNikud("שָׁלוֹם")', "Tasks/Chapter 3.md", "שלום"],
  // Numbers
  ["add / subtract / multiply / divide", "divide(multiply(add(Estimate, 3), subtract(10, 6)), 4)", "Tasks/Chapter 3.md", 8],
  ["round with places", "round(10 / 3, 2)", "Tasks/Chapter 3.md", 3.33],
  ["round (Notion's example)", "round(4.5)", "Tasks/Chapter 3.md", 5],
  ["mod / pow / sqrt / abs", "mod(17, 5) + pow(2, 3) + sqrt(16) + abs(-1)", "Tasks/Chapter 3.md", 15],
  ["sum / mean / median", "[sum([1, 2, 3]), mean([1, 2, 3, 6]), median([3, 1, 2])]", "Tasks/Chapter 3.md", [6, 3, 2]],
  ["toNumber", 'toNumber("42") + toNumber(true)', "Tasks/Chapter 3.md", 43],
  // Dates
  ["dateAdd: months clamp to the month's end", 'formatDate(dateAdd(parseDate("2026-01-31"), 1, "months"), "YYYY-MM-DD")', "Tasks/Chapter 3.md", "2026-02-28"],
  ["dateSubtract", 'formatDate(dateSubtract(Due, 2, "weeks"), "YYYY-MM-DD")', "Tasks/Chapter 3.md", "2026-11-06"],
  ["dateBetween: days left", 'dateBetween(Due, today(), "days")', "Tasks/Chapter 3.md", 8],
  ["dateBetween: a − b, toward zero (Notion's example)", 'dateBetween(parseDate("2022-09-07"), parseDate("2023-09-07"), "years")', "Tasks/Chapter 3.md", -1],
  ["dateBetween: months", 'dateBetween(parseDate("2026-03-15"), parseDate("2026-01-31"), "months")', "Tasks/Chapter 3.md", 1],
  ["formatDate", 'formatDate(Due, "MMMM D, YYYY")', "Tasks/Chapter 3.md", "November 20, 2026"],
  ["day: 1 is Monday (Notion's example)", 'day(parseDate("2023-07-10"))', "Tasks/Chapter 3.md", 1],
  ["day: Sunday is 7", 'day(parseDate("2026-11-15"))', "Tasks/Chapter 3.md", 7],
  ["week: ISO", 'week(parseDate("2023-01-02"))', "Tasks/Chapter 3.md", 1],
  ["year / month / dayOfMonth", "[year(Due), month(Due), dayOfMonth(Due)]", "Tasks/Chapter 3.md", [2026, 11, 20]],
  ["timestamp / fromTimestamp", 'formatDate(fromTimestamp(timestamp(parseDate("2026-11-12")) + 86400000), "YYYY-MM-DD")', "Tasks/Chapter 3.md", "2026-11-13"],
  ["Hebrew calendar", 'hebrewDate(parseDate("2026-11-12"))', "Tasks/Chapter 3.md", "ב׳ בכסלו תשפ״ז"],
  ["empty in, empty out (a row without the property)", 'dateBetween(Missing, today(), "days")', "Tasks/Chapter 3.md", null],
  // Lists, with current and index
  ["map with current", "map([1, 2, 3], current * 10)", "Tasks/Chapter 3.md", [10, 20, 30]],
  ["filter with index", "filter([5, 6, 7, 8], index % 2 == 0)", "Tasks/Chapter 3.md", [5, 7]],
  ["find / findIndex", 'find(Tags, current.contains("th")) + ":" + format(findIndex(Tags, current == "thesis"))', "Tasks/Chapter 3.md", "thesis:1"],
  ["some / every", "some([1, 5], current > 4) && !every([1, 5], current > 4)", "Tasks/Chapter 3.md", true],
  ["count with a condition", "count([1, 2, 3, 4], current > 2)", "Tasks/Chapter 3.md", 2],
  ["at: negative from the end", "at([1, 2, 3], -1)", "Tasks/Chapter 3.md", 3],
  ["first / last / slice (Notion's slice example)", '[first(Tags), last(Tags), slice(["Luffy", "Zoro", "Nami", "Chopper"], 1, 2)]', "Tasks/Chapter 3.md", ["writing", "thesis", ["Zoro"]]],
  ["sort / reverse / unique / includes", "[sort([2, 3, 1]), reverse([1, 2]), unique([1, 1, 2]), includes(Tags, \"thesis\")]", "Tasks/Chapter 3.md", [[1, 2, 3], [2, 1], [1, 2], true]],
  ["concat / flat", "flat(concat([1, [2]], [3]))", "Tasks/Chapter 3.md", [1, 2, 3]],
  // Lookups through relations (relation.<name>, current.prop, lookup)
  ["a rollup as a Notion formula: sum of estimates", 'sum(map(relation.subs, current.prop("Estimate")))', "Projects/Thesis.md", 15],
  ["share done", 'if(empty(relation.subs), "", round(count(relation.subs, current.prop("Done")) / length(relation.subs) * 100) + "%")', "Projects/Thesis.md", "67%"],
  ["lookup()", 'join(lookup(relation.subs, "Name"), ", ")', "Projects/Thesis.md", "Sub 1, Sub 2, Sub 3"],
  ["through a link property", 'lookup(relation.project, "Budget")', "Tasks/Chapter 3.md", [120]],
  ["the Bases rollup next to it", "rollup.estimate", "Projects/Thesis.md", 15],
];

const BASE = `relations:
  subs: { property: Parent, incoming: true }
  project: { property: Project }
rollups:
  estimate: { relation: subs, property: Estimate, function: sum }
views:
  - type: table
    name: All
`;

function run(formula: string, path: string): unknown {
  const text = `formulas:\n  f: ${JSON.stringify(formula)}\n${BASE}`;
  const p = parseBase(text);
  if (!p.ok) throw new Error(p.error);
  p.base.views[0].order = ["formula.f"];
  const r = runBase(p.base, files, { now: NOW });
  if (r.errors.length) throw new Error(r.errors.join("; "));
  const row = r.rows.find((x) => x.file.path === path)!;
  return plain(row.cells["formula.f"]);
}
const plain = (v: unknown): unknown => (Array.isArray(v) ? v.map(plain) : v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" ? toText(v as never) : v);

describe("Notion's formulas in Bases: the golden set (W6.46)", () => {
  for (const [name, formula, path, want] of GOLDEN) {
    it(name, () => {
      expect(run(formula, path)).toEqual(want);
    });
  }

  it(`${GOLDEN.length} cases, over every function group`, () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(50);
    const used = new Set(GOLDEN.flatMap(([, f]) => [...f.matchAll(/\b([a-zA-Z]+)\(/g)].map((m) => m[1])));
    const missing = NOTION_FUNCTIONS.filter((n) => !used.has(n));
    // Every Notion function is exercised but a few one-liners (covered in "the edges" below).
    expect(missing.sort()).toEqual(["cbrt", "ceil", "e", "exp", "floor", "hour", "ln", "log10", "log2", "minute", "pi", "sign", "trim"]);
  });
});

describe("the edges", () => {
  it("the one-liners", () => {
    expect(run("[ceil(1.2), floor(1.8), sign(-3), cbrt(27), round(exp(0)), ln(1), log10(1000), log2(8)]", "Tasks/Chapter 3.md")).toEqual([2, 1, -1, 3, 1, 0, 3, 3]);
    expect(run('[hour(parseDate("2026-11-12T09:30:00Z")), minute(parseDate("2026-11-12T09:30:00Z")), trim("  x  ")]', "Tasks/Chapter 3.md")).toEqual([9, 30, "x"]);
    expect(run("round(pi() * 100) + round(e())", "Tasks/Chapter 3.md")).toBe(317);
  });

  it("errors say what is wrong, and a bad unit is an error, not a guess", () => {
    expect(() => run('dateAdd(Due, 1, "fortnights")', "Tasks/Chapter 3.md")).toThrow(/unit is one of/);
    expect(() => run("divide(1, 0)", "Tasks/Chapter 3.md")).toThrow(/division by zero/);
    expect(() => run("let(1, 2, 3)", "Tasks/Chapter 3.md")).toThrow(/needs a name/);
    expect(() => run("ifs(true, 1)", "Tasks/Chapter 3.md")).toThrow(/pairs/);
  });

  it("an Obsidian global keeps its meaning (a .base must mean what it means in Obsidian)", () => {
    expect(run('date("2026-11-12") == parseDate("2026-11-12")', "Tasks/Chapter 3.md")).toBe(true);
    expect(run("max(1, 5, 3)", "Tasks/Chapter 3.md")).toBe(5);
    // Obsidian's methods with `value` still work next to Notion's globals with `current`.
    expect(run("[1, 2].map(value * 2) == map([1, 2], current * 2)", "Tasks/Chapter 3.md")).toBe(true);
  });

  it("dates: dateBetween over a month end and a leap day, ISO weeks at the year's edges", () => {
    expect(dateBetween(new Date("2024-03-01T00:00:00Z"), new Date("2024-02-29T00:00:00Z"), "days")).toBe(1);
    // As Day.js (Notion's date library) counts: Feb 29 + 1 year is Feb 28.
    expect(dateBetween(new Date("2025-02-27T00:00:00Z"), new Date("2024-02-29T00:00:00Z"), "years")).toBe(0);
    expect(dateBetween(new Date("2025-02-28T00:00:00Z"), new Date("2024-02-29T00:00:00Z"), "years")).toBe(1);
    expect(isoWeek(new Date("2021-01-03T00:00:00Z"))).toBe(53);
    expect(isoWeek(new Date("2026-12-31T00:00:00Z"))).toBe(53);
    expect(hebrewDate(new Date("2026-11-12T00:00:00Z"))).toBe("ב׳ בכסלו תשפ״ז");
    expect([15, 16, 5, 20, 5785].map(hebrewNumeral)).toEqual(["ט״ו", "ט״ז", "ה׳", "כ׳", "תשפ״ה"]);
  });
});
