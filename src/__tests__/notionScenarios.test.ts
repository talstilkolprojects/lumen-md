/**
 * Twenty Notion exports after import (plan W8.2): databases with formulas,
 * relations and rollups, in Notion's two export formats ("Markdown & CSV" and
 * "HTML"). Each scenario says what "works" means; the table this prints is
 * docs/src/content/docs/getting-started/from-notion.md's. Acceptance: at
 * least 18 of 20 work, and none fails silently: a scenario that does not
 * work must leave a warning in the import report.
 */
import { describe, it, expect } from "vitest";
import { convertNotion } from "../storage/import/notion";
import { splitFrontmatter } from "../storage/import/frontmatter";
import type { ConvertedVault } from "../storage/import/types";
import { parse as parseYaml } from "yaml";

const enc = new TextEncoder();
const id = (n: number) => n.toString(16).padStart(32, "a");
const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));
const csv = (rows: string[][]) => "\u{feff}" + rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");

function fm(vault: ConvertedVault, path: string): Record<string, unknown> {
  const text = vault.notes.get(path);
  if (text === undefined) throw new Error(`no note ${path}`);
  return splitFrontmatter(text).props as Record<string, unknown>;
}
function baseOrder(vault: ConvertedVault, path: string): string[] {
  const text = vault.notes.get(path) ?? "";
  const doc = parseYaml(text.replace(/^#.*\n/, "")) as { views: Array<{ order: string[] }> };
  return doc.views[0].order;
}
/** A Notion HTML database page: a header row whose icons name the column types, and rows. */
function htmlTable(title: string, cols: Array<[string, string]>, rows: string[][]): string {
  const th = cols.map(([name, type]) => `<th><span class="icon property-icon"><svg role="graphics-symbol" viewBox="0 0 16 16" class="types${type}"></svg></span>${name}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<html><body><article><h1 class="page-title">${title}</h1><div class="page-body"><table class="collection-content"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div></article></body></html>`;
}

interface Scenario {
  name: string;
  /** What "works" means here. */
  works: string;
  files: Map<string, Uint8Array>;
  check: (v: ConvertedVault) => void;
}

const DB = `Tasks ${id(1)}`;
const SC: Scenario[] = [
  {
    name: "1. Plain database: text, select, number",
    works: "a .base with the same columns in order; each row a note with its values typed",
    files: files({ [`${DB}.csv`]: csv([["Name", "Status", "Points"], ["Write", "Doing", "3"], ["Ship", "Done", "5"]]) }),
    check: (v) => {
      expect(baseOrder(v, "Tasks.base")).toEqual(["file.name", "note.Status", "note.Points"]);
      expect(fm(v, "Tasks/Write.md")).toEqual({ Status: "Doing", Points: 3 });
    },
  },
  {
    name: "2. Hebrew database and column names",
    works: "Hebrew titles, folders and keys come through as they are",
    files: files({ [`משימות ${id(2)}.csv`]: csv([["שם", "מצב"], ["לכתוב", "בתהליך"]]) }),
    check: (v) => expect(fm(v, "משימות/לכתוב.md")).toEqual({ "מצב": "בתהליך" }),
  },
  {
    name: "3. Checkbox",
    works: "Yes / No become true / false",
    files: files({ [`${DB}.csv`]: csv([["Name", "Done"], ["a", "Yes"], ["b", "No"]]) }),
    check: (v) => expect([fm(v, "Tasks/a.md").Done, fm(v, "Tasks/b.md").Done]).toEqual([true, false]),
  },
  {
    name: "4. Number formats: thousands and currency",
    works: "$1,200.00 and ₪45 become numbers",
    files: files({ [`${DB}.csv`]: csv([["Name", "Price"], ["a", "$1,200.00"], ["b", "₪45"]]) }),
    check: (v) => expect([fm(v, "Tasks/a.md").Price, fm(v, "Tasks/b.md").Price]).toEqual([1200, 45]),
  },
  {
    name: "5. Percent",
    works: "45% becomes 0.45, the number Notion stores",
    files: files({ [`${DB}.csv`]: csv([["Name", "Progress"], ["a", "45%"], ["b", "100%"]]) }),
    check: (v) => expect([fm(v, "Tasks/a.md").Progress, fm(v, "Tasks/b.md").Progress]).toEqual([0.45, 1]),
  },
  {
    name: "6. Dates and date-times",
    works: "ISO dates the base can sort and filter",
    files: files({ [`${DB}.csv`]: csv([["Name", "Due"], ["a", "January 31, 2024"], ["b", "March 5, 2023 2:30 PM"]]) }),
    check: (v) => expect([fm(v, "Tasks/a.md").Due, fm(v, "Tasks/b.md").Due]).toEqual(["2024-01-31", "2023-03-05T14:30"]),
  },
  {
    name: "7. Date range",
    works: "the start in the column, the end in `<column> end`, both in the base",
    files: files({ [`${DB}.csv`]: csv([["Name", "When"], ["Trip", "November 14, 2026 → November 20, 2026"], ["Day", "December 1, 2026"]]) }),
    check: (v) => {
      expect(fm(v, "Tasks/Trip.md")).toEqual({ When: "2026-11-14", "When end": "2026-11-20" });
      expect(fm(v, "Tasks/Day.md")).toEqual({ When: "2026-12-01" });
      expect(baseOrder(v, "Tasks.base")).toEqual(["file.name", "note.When", "note.When end"]);
    },
  },
  {
    name: "8. Multi-select",
    works: "kept as Notion writes it (`a, b`), so `contains` filters find each value",
    files: files({ [`${DB}.csv`]: csv([["Name", "Tags"], ["a", "red, blue"]]) }),
    check: (v) => expect(fm(v, "Tasks/a.md").Tags).toBe("red, blue"),
  },
  {
    name: "9. Relation to another database's rows",
    works: "a list of [[links]] to the related notes, which exist",
    files: files({
      [`${DB}.csv`]: csv([["Name", "Project"], ["a", `Apollo (../Projects%20${id(3)}/Apollo%20${id(4)}.md)`]]),
      [`Projects ${id(3)}.csv`]: csv([["Name"], ["Apollo"]]),
    }),
    check: (v) => {
      expect(fm(v, "Tasks/a.md").Project).toEqual(["[[Apollo]]"]);
      expect(v.notes.has("Projects/Apollo.md")).toBe(true);
    },
  },
  {
    name: "10. Relation written as notion.so links, two of them",
    works: "both become [[links]]",
    files: files({ [`${DB}.csv`]: csv([["Name", "Related"], ["a", "Emma (https://www.notion.so/Emma-1), Dune (https://www.notion.so/Dune-2)"]]) }),
    check: (v) => expect(fm(v, "Tasks/a.md").Related).toEqual(["[[Emma]]", "[[Dune]]"]),
  },
  {
    name: "11. Rollup of numbers (CSV)",
    works: "the computed values as numbers",
    files: files({ [`${DB}.csv`]: csv([["Name", "Total hours"], ["a", "12.5"], ["b", "3"]]) }),
    check: (v) => expect([fm(v, "Tasks/a.md")["Total hours"], fm(v, "Tasks/b.md")["Total hours"]]).toEqual([12.5, 3]),
  },
  {
    name: "12. Formula (HTML export names it)",
    works: "the values come through and the report says the formula itself did not",
    files: files({ [`Budget ${id(5)}.html`]: htmlTable("Budget", [["Name", "Title"], ["Price", "Number"], ["With VAT", "Formula"]], [["Desk", "100", "117"], ["Chair", "50", "58.5"]]) }),
    check: (v) => {
      expect(fm(v, "Budget/Desk.md")).toEqual({ Price: 100, "With VAT": 117 });
      expect(v.warnings).toContainEqual({ path: "Budget.base", reason: "notionComputed", detail: "With VAT" });
    },
  },
  {
    name: "13. Rollup (HTML export names it)",
    works: "the values come through and the report names the rollup",
    files: files({ [`Teams ${id(6)}.html`]: htmlTable("Teams", [["Name", "Title"], ["Members", "Rollup"]], [["Core", "4"]]) }),
    check: (v) => {
      expect(fm(v, "Teams/Core.md").Members).toBe(4);
      expect(v.warnings.some((w) => w.reason === "notionComputed" && w.detail === "Members")).toBe(true);
    },
  },
  {
    name: "14. Formula with text values",
    works: "the text values as they were shown",
    files: files({ [`${DB}.csv`]: csv([["Name", "Label"], ["a", "Late (3 days)"], ["b", "On time"]]) }),
    check: (v) => expect([fm(v, "Tasks/a.md").Label, fm(v, "Tasks/b.md").Label]).toEqual(["Late (3 days)", "On time"]),
  },
  {
    name: "15. URL, email and phone",
    works: "kept as text, unchanged",
    files: files({ [`${DB}.csv`]: csv([["Name", "Site", "Mail", "Phone"], ["a", "https://example.com/a?b=1", "dana@example.com", "+972-3-555-1234"]]) }),
    check: (v) => expect(fm(v, "Tasks/a.md")).toEqual({ Site: "https://example.com/a?b=1", Mail: "dana@example.com", Phone: "+972-3-555-1234" }),
  },
  {
    name: "16. Person and Created by",
    works: "the names as text",
    files: files({ [`${DB}.csv`]: csv([["Name", "Owner", "Created by"], ["a", "Dana Levi, Tal", "Tal"]]) }),
    check: (v) => expect(fm(v, "Tasks/a.md")).toEqual({ Owner: "Dana Levi, Tal", "Created by": "Tal" }),
  },
  {
    name: "17. Created time and Last edited time",
    works: "date-times the base can sort",
    files: files({ [`${DB}.csv`]: csv([["Name", "Created", "Edited"], ["a", "November 14, 2026 9:15 AM", "November 15, 2026 11:00 PM"]]) }),
    check: (v) => expect(fm(v, "Tasks/a.md")).toEqual({ Created: "2026-11-14T09:15", Edited: "2026-11-15T23:00" }),
  },
  {
    name: "18. Row pages with their own content",
    works: "the page body kept, the cells Notion repeats under the title moved into the frontmatter",
    files: files({
      [`${DB}.csv`]: csv([["Name", "Status"], ["Write", "Doing"]]),
      [`${DB}/Write ${id(7)}.md`]: "# Write\n\nStatus: Doing\n\nThe real text of the page.\n",
    }),
    check: (v) => {
      const text = v.notes.get("Tasks/Write.md")!;
      expect(fm(v, "Tasks/Write.md")).toEqual({ Status: "Doing" });
      expect(text).toContain("The real text of the page.");
      expect(splitFrontmatter(text).body).not.toMatch(/^Status: Doing$/m);
    },
  },
  {
    name: "19. The view's CSV and `_all.csv`",
    works: "every row from `_all.csv`; the view's copy reported as a duplicate",
    files: files({ [`${DB}.csv`]: csv([["Name"], ["a"]]), [`${DB}_all.csv`]: csv([["Name"], ["a"], ["hidden by the view"]]) }),
    check: (v) => {
      expect(v.notes.has("Tasks/hidden by the view.md")).toBe(true);
      expect(v.skipped).toContainEqual({ path: `${DB}.csv`, reason: "duplicate" });
    },
  },
  {
    name: "20. A number column with one odd cell",
    works: "kept as text, and the report names the column and the cell",
    files: files({ [`${DB}.csv`]: csv([["Name", "Score"], ["a", "10"], ["b", "12"], ["c", "N/A"], ["d", "7"], ["e", "9"], ["f", "11"]]) }),
    check: (v) => {
      expect(fm(v, "Tasks/c.md").Score).toBe("N/A");
      expect(v.warnings).toContainEqual({ path: "Tasks.base", reason: "notionUnparsed", detail: "Score: N/A" });
    },
  },
];

describe("20 Notion scenarios after import (plan W8.2)", () => {
  it("at least 18 work, and none fails silently", () => {
    const table: string[] = ["| scenario | works when | result |", "| --- | --- | --- |"];
    let ok = 0;
    const silent: string[] = [];
    for (const s of SC) {
      const v = convertNotion(s.files, { folder: "Imported/Notion" });
      let result = "✓";
      try {
        s.check(v);
        ok++;
      } catch (e) {
        result = `✗ ${(e as Error).message.split("\n")[0]}`;
        // Not silent: a scenario that does not work left something in the report.
        if (v.warnings.length + v.skipped.length === 0) silent.push(s.name);
      }
      table.push(`| ${s.name} | ${s.works} | ${result} |`);
    }
    console.log(table.join("\n"));
    expect(silent).toEqual([]);
    expect(SC).toHaveLength(20);
    expect(ok).toBeGreaterThanOrEqual(18);
  });
});
