/**
 * W1.12 — relations and rollups in Bases, the calendar / timeline data and
 * their date moves, the virtual table window, CSV out and in, and 10,000 rows.
 */
import { describe, expect, it } from "vitest";
import { basesFileFromText, parseBase, runBase, viewKind } from "../views/bases/base";
import { toText, type BValue } from "../views/bases/values";
import {
  addDays,
  csvToNotes,
  dayKey,
  monthWeeks,
  moveDateInText,
  movedDateValue,
  parseCsvRows,
  pinnedProperties,
  resultToCsv,
  rowsByDay,
  timelineItems,
  visibleWindow,
} from "../views/bases/viewsData";

const note = (path: string, fm: string, body = "") => basesFileFromText(path, `---\n${fm}\n---\n${body}`);

const VAULT = [
  note("Projects/Alpha.md", 'type: project\nowner: "[[Dana]]"\nmembers: ["[[Dana]]", "[[Omer]]"]'),
  note("Projects/Beta.md", 'type: project\nowner: "[[Omer]]"\nmembers: ["[[Omer]]"]'),
  note("Projects/Gamma.md", "type: project"),
  note("Projects/Delta.md", 'type: project\nowner: "[[Nobody]]"'),
  note("People/Dana.md", "type: person\nrate: 100\njoined: 2020-05-01"),
  note("People/Omer.md", "type: person\nrate: 80\njoined: 2022-01-15"),
  note("Tasks/T1.md", 'type: task\nproject: "[[Alpha]]"\nestimate: 3\ndue: 2026-03-01\ndone: true'),
  note("Tasks/T2.md", 'type: task\nproject: "[[Alpha|A]]"\nestimate: 5\ndue: 2026-02-10\ndone: false'),
  note("Tasks/T3.md", 'type: task\nproject: ["[[Alpha]]", "[[Projects/Beta]]"]\nestimate: 2\ndue: 2026-04-05'),
  note("Tasks/T4.md", 'type: task\nproject: "[[Beta]]"\nestimate: "4"\ndue: 2026-01-20'),
  note("Tasks/T5.md", 'type: task\nproject: "[[Beta]]"'),
  note("Tasks/T6.md", 'type: task\nproject: "[[Missing]]"\nestimate: 10'),
  note("Tasks/T7.md", 'type: task\nproject: "[[Delta]]"\nestimate: -1.5\ndue: 2025-12-31'),
  note("Tasks/T8.md", 'type: task\nproject: "[[Alpha]]"\nestimate: 0.1\ndue: 2026-03-01T09:30'),
];

const BASE = `
formulas:
  double: note.estimate * 2
relations:
  tasks:
    property: project
    incoming: true
  team: members
  lead: owner
  proj: project
rollups:
  task_count: { relation: tasks, function: count }
  hours: { relation: tasks, property: estimate, function: sum }
  avg_hours: { relation: tasks, property: estimate, function: avg }
  min_hours: { relation: tasks, property: estimate, function: min }
  max_hours: { relation: tasks, property: estimate, function: max }
  first_due: { relation: tasks, property: due, function: earliest }
  last_due: { relation: tasks, property: due, function: latest }
  double_hours: { relation: tasks, property: formula.double, function: sum }
  team_size: { relation: team, function: count }
  team_cost: { relation: team, property: rate, function: sum }
  team_avg: { relation: team, property: rate, function: avg }
  team_min: { relation: team, property: rate, function: min }
  first_joined: { relation: team, property: joined, function: earliest }
  last_joined: { relation: team, property: joined, function: latest }
  lead_count: { relation: lead, function: count }
  lead_rate: { relation: lead, property: rate, function: max }
  project_count: { relation: proj, function: count }
  project_team: { relation: proj, property: rollup.team_size, function: sum }
views:
  - type: table
    name: All
    order: [file.name, relation.tasks, rollup.hours]
`;

const parsed = parseBase(BASE);
if (!parsed.ok) throw new Error(parsed.error);
const base = parsed.base;

/** The value of `id` on one note, through a one-column view filtered to it. */
function cell(path: string, id: string): BValue {
  const views = [{ type: "table", name: "x", order: [id], sort: [], summaries: {}, filters: `file.path == "${path}"` }];
  const r = runBase({ ...base, views }, VAULT);
  expect(r.errors).toEqual([]);
  expect(r.rows.length).toBe(1);
  return r.rows[0].cells[id];
}
const asDay = (v: BValue) => (v instanceof Date ? dayKey(v) : v);

/** 30 golden rollups, worked out by hand from the vault above. */
const GOLDEN: Array<[string, string, BValue]> = [
  ["Projects/Alpha.md", "rollup.task_count", 4],
  ["Projects/Alpha.md", "rollup.hours", 10.1],
  ["Projects/Alpha.md", "rollup.avg_hours", 2.525],
  ["Projects/Alpha.md", "rollup.min_hours", 0.1],
  ["Projects/Alpha.md", "rollup.max_hours", 5],
  ["Projects/Alpha.md", "rollup.first_due", "2026-02-10"],
  ["Projects/Alpha.md", "rollup.last_due", "2026-04-05"],
  ["Projects/Alpha.md", "rollup.double_hours", 20.2],
  ["Projects/Beta.md", "rollup.task_count", 3],
  ["Projects/Beta.md", "rollup.hours", 6],
  ["Projects/Beta.md", "rollup.avg_hours", 3],
  ["Projects/Beta.md", "rollup.min_hours", 2],
  ["Projects/Beta.md", "rollup.first_due", "2026-01-20"],
  ["Projects/Gamma.md", "rollup.task_count", 0],
  ["Projects/Gamma.md", "rollup.hours", 0],
  ["Projects/Gamma.md", "rollup.avg_hours", null],
  ["Projects/Gamma.md", "rollup.first_due", null],
  ["Projects/Delta.md", "rollup.task_count", 1],
  ["Projects/Delta.md", "rollup.min_hours", -1.5],
  ["Projects/Delta.md", "rollup.last_due", "2025-12-31"],
  ["Projects/Delta.md", "rollup.lead_count", 0],
  ["Projects/Alpha.md", "rollup.team_size", 2],
  ["Projects/Alpha.md", "rollup.team_cost", 180],
  ["Projects/Alpha.md", "rollup.team_avg", 90],
  ["Projects/Alpha.md", "rollup.team_min", 80],
  ["Projects/Alpha.md", "rollup.first_joined", "2020-05-01"],
  ["Projects/Alpha.md", "rollup.last_joined", "2022-01-15"],
  ["Projects/Alpha.md", "rollup.lead_rate", 100],
  ["Tasks/T3.md", "rollup.project_count", 2],
  ["Tasks/T3.md", "rollup.project_team", 3],
];

describe("rollups: 30 golden cases", () => {
  it("has 30 cases", () => expect(GOLDEN.length).toBe(30));
  for (const [path, id, want] of GOLDEN) {
    it(`${path} ${id} = ${String(want)}`, () => {
      expect(asDay(cell(path, id))).toEqual(want);
    });
  }
});

describe("relations", () => {
  it("follow a link property out, and back in (incoming)", () => {
    const names = (v: BValue) => (Array.isArray(v) ? v.map((x) => toText(x)).sort() : v);
    expect(names(cell("Projects/Alpha.md", "relation.tasks"))).toEqual(["T1", "T2", "T3", "T8"]);
    expect(names(cell("Projects/Alpha.md", "relation.team"))).toEqual(["Dana", "Omer"]);
    expect(names(cell("Tasks/T3.md", "relation.proj"))).toEqual(["Alpha", "Beta"]);
    expect(names(cell("Tasks/T6.md", "relation.proj"))).toEqual([]);
  });

  it("label their columns by name, and reject a rollup over an unknown relation", () => {
    const r = runBase(base, VAULT);
    expect(r.columns.map((c) => c.label)).toEqual(["file.name", "tasks", "hours"]);
    const bad = parseBase("rollups:\n  x: { relation: nope, function: sum, property: a }\n");
    expect(bad.ok).toBe(false);
    const fn = parseBase("relations:\n  r: p\nrollups:\n  x: { relation: r, function: median, property: a }\n");
    expect(fn.ok).toBe(false);
  });
});

describe("calendar and timeline", () => {
  const view = (type: string, extra = "") => parseBase(`filters: 'type == "task"'\nviews:\n  - type: ${type}\n    name: v\n    date: due\n${extra}`);

  it("are view types, and place rows by their date", () => {
    const p = view("calendar");
    if (!p.ok) throw new Error(p.error);
    expect(viewKind(p.base.views[0])).toBe("calendar");
    const r = runBase(p.base, VAULT);
    const byDay = rowsByDay(r.rows, "note.due");
    expect(byDay.get("2026-03-01")!.map((x) => x.file.basename).sort()).toEqual(["T1", "T8"]);
    expect([...byDay.values()].flat().length).toBe(6); // T5 and T6 have no date
  });

  it("lays out a month from its first weekday", () => {
    const weeks = monthWeeks(2026, 3, 7); // March 2026 starts on a Sunday
    expect(weeks[0][0]).toBe("2026-03-01");
    expect(weeks.flat().filter(Boolean).length).toBe(31);
    expect(monthWeeks(2026, 3, 1)[0].slice(0, 7)).toEqual([null, null, null, null, null, null, "2026-03-01"]);
  });

  it("spans timeline items from start to end", () => {
    const p = view("timeline", "    end: finish\n");
    if (!p.ok) throw new Error(p.error);
    const files = [note("a.md", "type: task\ndue: 2026-01-05\nfinish: 2026-01-09"), note("b.md", "type: task\ndue: 2026-01-07\nfinish: 2026-01-01")];
    const r = runBase(p.base, files);
    const tl = timelineItems(r.rows, "note.due", "note.finish");
    expect(tl.items.map((i) => [i.start, i.end])).toEqual([
      ["2026-01-05", "2026-01-09"],
      ["2026-01-07", "2026-01-07"], // an end before the start is ignored
    ]);
    expect([tl.from, tl.to]).toEqual(["2026-01-05", "2026-01-09"]);
  });

  it("moving an item changes only its date property, keeping the rest byte for byte", () => {
    const text = '---\ntitle: "Plan — שלב א׳"\ndue: 2026-03-01\ntags: [a, b]\n# a comment\n---\n\nBody with due: 2026-03-01 in it.\n';
    const moved = moveDateInText(text, "due", "2026-03-01", "2026-03-04");
    expect(moved).toBe(text.replace("due: 2026-03-01\n", "due: 2026-03-04\n"));
    // Round trip: moving back gives the original file.
    expect(moveDateInText(moved, "due", "2026-03-04", "2026-03-01")).toBe(text);
    // A date-time keeps its time.
    expect(movedDateValue("2026-03-01T09:30", "2026-03-02")).toBe("2026-03-02T09:30");
    expect(movedDateValue(new Date(Date.UTC(2026, 2, 1)), "2026-03-02")).toBe("2026-03-02");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("the virtual table", () => {
  it("draws only the rows in sight", () => {
    expect(visibleWindow(10_000, 28, 0, 480)).toEqual({ start: 0, end: 26 });
    const mid = visibleWindow(10_000, 28, 28 * 5000, 480);
    expect(mid.start).toBe(4992);
    expect(mid.end - mid.start).toBeLessThan(40);
    expect(visibleWindow(10_000, 28, 28 * 10_000, 480).end).toBe(10_000);
  });
});

describe("CSV", () => {
  it("parses RFC 4180: quotes, commas, line breaks, a BOM", () => {
    expect(parseCsvRows('﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\n\r\nx,y\n')).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["x", "y"],
    ]);
  });

  it("exports a view and imports it back as notes that match the base", () => {
    const p = parseBase('filters:\n  and:\n    - \'type == "task"\'\n    - \'file.ext == "md"\'\nviews:\n  - type: table\n    name: t\n    order: [file.name, estimate, due]\n');
    if (!p.ok) throw new Error(p.error);
    const r = runBase(p.base, VAULT.filter((f) => f.fm.type === "task"));
    const csv = resultToCsv(r);
    expect(csv.split("\r\n")[0]).toBe("file.name,estimate,due");
    expect(csv).toContain("T1,3,2026-03-01\r\n");
    const extra = pinnedProperties(p.base.filters);
    expect(extra).toEqual({ type: "task" });
    const notes = csvToNotes(csv, "Imported", { extra, taken: new Set(["Imported/T1.md"]) });
    expect(notes.length).toBe(r.rows.length);
    expect(notes[0].path).toBe("Imported/T1 2.md");
    const back = basesFileFromText(notes[0].path, notes[0].content);
    expect(back.fm).toEqual({ type: "task", estimate: 3, due: "2026-03-01" });
    // Hebrew headers and names survive.
    const he = csvToNotes("שם,תאריך יעד,הושלם\nמשימה: א/ב,2026-01-01,true\n", "ייבוא");
    expect(he[0].path).toBe("ייבוא/משימה א ב.md");
    expect(basesFileFromText(he[0].path, he[0].content).fm).toEqual({ תאריך_יעד: "2026-01-01", הושלם: true });
  });
});

describe("10,000 rows", () => {
  const files = Array.from({ length: 10_000 }, (_, i) =>
    note(`n/${i}.md`, `type: ${i % 3 ? "task" : "note"}\nestimate: ${i % 17}\ndue: 2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}\nstatus: ${i % 5 ? "open" : "done"}`),
  );
  it("filters, sorts and draws a page in under 100 ms", () => {
    const p = parseBase('filters:\n  and:\n    - \'type == "task"\'\n    - \'status == "open"\'\n    - note.estimate > 3\nviews:\n  - type: table\n    name: t\n    order: [file.name, estimate, due]\n    sort:\n      - property: due\n        direction: DESC\n');
    if (!p.ok) throw new Error(p.error);
    // Steady state, as when the user types a filter: warm up, then the best of three.
    for (let i = 0; i < 3; i++) runBase(p.base, files);
    let ms = Infinity;
    let r = runBase(p.base, files);
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      r = runBase(p.base, files);
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(r.errors).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(100);
  });
});
