/**
 * The database view's filter language (4.10): Dataview-style AND / OR / NOT,
 * comparisons and a few functions over frontmatter.
 */
import { describe, expect, it } from "vitest";
import { matchesFilter, parseFilter, type FilterRow } from "../views/databaseFilter";

const row = (fm: Record<string, unknown>, path = "books/Invisible Cities.md"): FilterRow => ({
  fm,
  file: { name: path.split("/").pop()!.replace(/\.md$/, ""), path, folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
});

const test = (expr: string, fm: Record<string, unknown>, path?: string) => {
  const p = parseFilter(expr);
  if (!p.ok) throw new Error(`${p.error} at ${p.at}`);
  return matchesFilter(p.tree, row(fm, path));
};

describe("parseFilter", () => {
  it("an empty expression is no filter", () => {
    expect(parseFilter("  ")).toEqual({ ok: true, tree: null });
    expect(matchesFilter(null, row({}))).toBe(true);
  });

  it("AND binds tighter than OR; parentheses and NOT", () => {
    const fm = { status: "done", rating: 2, fav: false };
    expect(test('status = "done" OR rating >= 4 AND fav', fm)).toBe(true);
    expect(test('(status = "done" OR rating >= 4) AND fav', fm)).toBe(false);
    expect(test('NOT fav and !(rating > 3) && status == "done"', fm)).toBe(true);
    expect(test('status != "done" || rating < 3', fm)).toBe(true);
  });

  it("keywords are case-insensitive; field names may be Hebrew or dotted", () => {
    expect(test('סטטוס = "הושלם" and דירוג >= 4', { סטטוס: "הושלם", דירוג: 5 })).toBe(true);
    expect(test('file.folder = "books" AND file.name = "Invisible Cities"', {})).toBe(true);
    expect(test('meta.owner = "tal"', { meta: { owner: "tal" } })).toBe(true);
  });

  it("file.name / path / folder are the note's own even when the frontmatter has a `file` key", () => {
    expect(test('file.name = "Invisible Cities" and file.folder = "books"', { file: "scan.pdf" })).toBe(true);
    expect(test('file.kind = "pdf"', { file: { kind: "pdf" } })).toBe(true);
  });

  it("reports the error and where it is", () => {
    expect(parseFilter('status = "done')).toMatchObject({ ok: false, error: "unclosed string", at: 9 });
    expect(parseFilter("rating >= ")).toMatchObject({ ok: false, error: "expression ends too early" });
    expect(parseFilter("a = 1 b")).toMatchObject({ ok: false, at: 6 });
    expect(parseFilter("explode(x)")).toMatchObject({ ok: false, error: 'unknown function "explode"' });
    expect(parseFilter("contains(tags)")).toMatchObject({ ok: false, error: "contains() takes 2 arguments" });
    expect(parseFilter("and x")).toMatchObject({ ok: false });
  });
});

describe("matchesFilter", () => {
  it("numbers compare as numbers, ISO dates as dates, the rest as text", () => {
    expect(test("rating > 10", { rating: 9 })).toBe(false);
    expect(test('rating > "10"', { rating: 11 })).toBe(true);
    expect(test('due < "2026-11-01"', { due: "2026-10-20" })).toBe(true);
    expect(test('due < "2026-11-01"', { due: "2026-12-01" })).toBe(false);
    expect(test('title >= "b"', { title: "c" })).toBe(true);
  });

  it("a missing value equals only null and fails < > comparisons", () => {
    expect(test("rating = null", {})).toBe(true);
    expect(test("rating != null", { rating: 0 })).toBe(true);
    expect(test("rating < 5", {})).toBe(false);
    expect(test("rating", {})).toBe(false);
  });

  it("lists: = holds-the-value, contains, empty", () => {
    const fm = { tags: ["fav", "sci-fi"], blank: [] };
    expect(test('tags = "fav"', fm)).toBe(true);
    expect(test('contains(tags, "sci-fi") and !contains(tags, "poetry")', fm)).toBe(true);
    expect(test("empty(blank) and empty(nothing) and !empty(tags)", fm)).toBe(true);
  });

  it("text functions ignore case", () => {
    expect(test('contains(title, "CITIES") and startswith(title, "inv") and endswith(file.name, "ities")', { title: "Invisible Cities" })).toBe(true);
  });

  it("booleans and truthiness", () => {
    expect(test("done = true", { done: true })).toBe(true);
    expect(test("done", { done: false })).toBe(false);
    expect(test("!done", { done: false })).toBe(true);
  });
});
