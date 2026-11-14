/**
 * Obsidian Bases expressions (plan W1.11): every documented function that
 * is marked supported is exercised here at least once, and the ones that
 * are not give a clear error instead of a wrong value.
 */
import { describe, it, expect } from "vitest";
import { basesFileFromText, buildVault } from "../views/bases/base";
import { BASES_DOCUMENTED, BASES_UNSUPPORTED, evaluateBases, formatMoment, parseBases } from "../views/bases/evaluate";
import { toPlain, type BValue } from "../views/bases/values";

const NOW = new Date("2026-11-10T12:30:00Z");
const dune = basesFileFromText("Books/Dune.md", "---\ntitle: Dune\nrating: 5\nprice: 9.99\ntags: [book, scifi/classic]\nup: \"[[Index]]\"\ndue: 2026-11-20\nmeta:\n  a: 1\n  b: two\n---\nSee [[Foundation]] and ![[cover.png]] #desert\n", { mtime: new Date("2026-11-03T12:30:00Z"), size: 120 });
const foundation = basesFileFromText("Books/Foundation.md", "---\nrating: 4\n---\nBack to [[Dune]].\n", { mtime: new Date("2026-01-01T00:00:00Z") });
const index = basesFileFromText("Index.md", "[[Dune]]\n", {});
const files = [dune, foundation, index];
const vault = buildVault(files);

function run(src: string, locals?: Record<string, BValue>): unknown {
  const p = parseBases(src);
  if (!p.ok) return { parseError: p.error.message };
  const r = evaluateBases(p.tree, { file: dune, vault, thisFile: index, locals }, { now: NOW, random: () => 0.25 });
  return r.ok ? toPlain(r.value) : { error: r.error.message };
}

/** [documented name, expression, expected value]. */
const CASES: Array<[string, string, unknown]> = [
  ["global.escapeHTML", 'escapeHTML("<b>a & b</b>")', "&lt;b&gt;a &amp; b&lt;/b&gt;"],
  ["global.date", 'date("2026-11-20").day', 20],
  ["global.duration", 'duration("2w").days', 14],
  ["global.file", 'file("Foundation").name', "Foundation.md"],
  ["global.if", 'if(rating > 4, "great", "ok")', "great"],
  ["global.image", 'image("cover.png")', "cover.png"],
  ["global.link", 'link("Index", "Home")', "Home"],
  ["global.list", 'list("one").length', 1],
  ["global.max", "max(1, 7, 3)", 7],
  ["global.min", "min(4, 2, 9)", 2],
  ["global.now", 'now().format("HH:mm")', "12:30"],
  ["global.number", 'number("12.5") + 1', 13.5],
  ["global.today", 'today().format("YYYY-MM-DD")', "2026-11-10"],
  ["global.random", "random()", 0.25],
  ["any.isTruthy", '"".isTruthy()', false],
  ["any.isType", 'rating.isType("number")', true],
  ["any.toString", "rating.toString()", "5"],
  ["date.date", 'now().date().format("HH:mm")', "00:00"],
  ["date.format", 'date("2026-11-03").format("dddd, Do MMM YY")', "Tuesday, 3rd Nov 26"],
  ["date.time", "now().time()", "12:30:00"],
  ["date.relative", "file.mtime.relative()", "last week"],
  ["date.isEmpty", "now().isEmpty()", false],
  ["string.contains", 'title.contains("un")', true],
  ["string.containsAll", 'title.containsAll("D", "e")', true],
  ["string.containsAny", 'title.containsAny("x", "u")', true],
  ["string.endsWith", 'title.endsWith("ne")', true],
  ["string.isEmpty", '"".isEmpty()', true],
  ["string.lower", "title.lower()", "dune"],
  ["string.replace", 'title.replace(/u/, "o")', "Done"],
  ["string.repeat", '"ab".repeat(3)', "ababab"],
  ["string.reverse", "title.reverse()", "enuD"],
  ["string.slice", "title.slice(1, 3)", "un"],
  ["string.split", '"a,b,c".split(",").length', 3],
  ["string.startsWith", 'title.startsWith("Du")', true],
  ["string.title", '"the long road".title()', "The Long Road"],
  ["string.trim", '"  x ".trim()', "x"],
  ["number.abs", "(-3).abs()", 3],
  ["number.ceil", "price.ceil()", 10],
  ["number.floor", "price.floor()", 9],
  ["number.isEmpty", "rating.isEmpty()", false],
  ["number.round", "price.round(1)", 10],
  ["number.toFixed", "price.toFixed(1)", "10.0"],
  ["list.contains", 'tags.contains("book")', true],
  ["list.containsAll", 'tags.containsAll("book", "scifi/classic")', true],
  ["list.containsAny", 'tags.containsAny("x", "book")', true],
  ["list.filter", 'tags.filter(value.startsWith("sci"))', ["scifi/classic"]],
  ["list.flat", "[[1, 2], [3]].flat()", [1, 2, 3]],
  ["list.isEmpty", "[].isEmpty()", true],
  ["list.join", 'tags.join(" | ")', "book | scifi/classic"],
  ["list.map", "[1, 2, 3].map(value * index)", [0, 2, 6]],
  ["list.reduce", "[1, 2, 3, 4].reduce(acc + value, 10)", 20],
  ["list.reverse", "[1, 2, 3].reverse()", [3, 2, 1]],
  ["list.slice", "[1, 2, 3, 4].slice(1, 3)", [2, 3]],
  ["list.sort", "[3, 1, 2].sort()", [1, 2, 3]],
  ["list.unique", "[1, 1, 2, 1].unique()", [1, 2]],
  ["link.asFile", "up.asFile().name", "Index.md"],
  ["link.linksTo", 'up.linksTo("Dune")', true],
  ["file.asLink", 'file.asLink("me")', "me"],
  ["file.hasLink", 'file.hasLink("Foundation")', true],
  ["file.hasProperty", 'file.hasProperty("due")', true],
  ["file.hasTag", 'file.hasTag("scifi")', true],
  ["file.inFolder", 'file.inFolder("Books")', true],
  ["object.isEmpty", "meta.isEmpty()", false],
  ["object.keys", "meta.keys()", ["a", "b"]],
  ["object.values", "meta.values()", [1, "two"]],
  ["regexp.matches", '/^D.n/.matches(title)', true],
  ["global.html", 'html("<b>bold</b>")', "bold"],
];

describe("Bases functions (W1.11)", () => {
  it.each(CASES)("%s", (_name, src, want) => {
    expect(run(src), src).toEqual(want);
  });

  it("every documented, supported function has a case", () => {
    const covered = new Set(CASES.map((c) => c[0]));
    const missing = BASES_DOCUMENTED.filter((n) => !BASES_UNSUPPORTED.has(n) && !covered.has(n));
    expect(missing).toEqual([]);
  });

  it("an unsupported function is a clear parse error, not a wrong value", () => {
    expect(run('icon("star")')).toEqual({ parseError: "Bases function icon() is not supported here yet" });
    expect(run("nope(1)")).toEqual({ parseError: 'unknown function "nope"' });
    expect(run("title.frobnicate()")).toEqual({ parseError: 'unknown function "frobnicate"' });
  });

  it("namespaces: note., file., this., bare names and note[\"…\"]", () => {
    expect(run("note.rating == rating")).toBe(true);
    expect(run('note["rating"] + 1')).toBe(6);
    expect(run("file.folder")).toBe("Books");
    expect(run("file.ext")).toBe("md");
    expect(run("file.basename")).toBe("Dune");
    expect(run("file.size")).toBe(120);
    expect(run("file.tags")).toEqual(["book", "scifi/classic", "desert"]);
    expect(run("file.embeds")).toEqual(["cover.png"]);
    expect(run("file.links.length")).toBe(2);
    expect(run("file.backlinks.length")).toBe(2);
    expect(run("this.file.name")).toBe("Index.md");
    expect(run("missing")).toBeNull();
    expect(run("missing.contains(1)")).toBeNull();
  });

  it("dates and durations", () => {
    expect(run('date("2026-01-31") + "1M"')).toBe("2026-02-28");
    expect(run('(date(due) - today()).days')).toBe(10);
    expect(run('due > today()')).toBe(true);
    expect(run('today() - "1 week"')).toBe("2026-11-03");
    expect(run('date("2026-11-20").year')).toBe(2026);
    expect(run('date("soon")')).toEqual({ error: 'date() needs a date like "2026-11-10", not "soon"' });
  });

  it("operators", () => {
    expect(run("1 + 2 * 3 - 4 / 2")).toBe(5);
    expect(run("7 % 3")).toBe(1);
    expect(run('"a" + 1')).toBe("a1");
    expect(run("!(1 > 2) && (2 >= 2 || false)")).toBe(true);
    expect(run('title || "x"')).toBe("Dune");
    expect(run("1 / 0")).toEqual({ error: "division by zero" });
    expect(run("0.1 + 0.2")).toBe(0.3);
    expect(run("rating === 5")).toBe(true);
  });

  it("parse errors say where", () => {
    const p = parseBases("rating >");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.message).toBe("the expression ends too early");
    const q = parseBases('"open');
    expect(q.ok).toBe(false);
  });

  it("limits: a runaway reduce stops on the step budget", () => {
    const p = parseBases('"ab".repeat(9000).split("").map(value + value).length');
    expect(p.ok).toBe(true);
    if (p.ok) {
      const r = evaluateBases(p.tree, { file: dune }, { now: NOW });
      expect(r.ok).toBe(false);
    }
  });

  it("formatMoment keeps [literal] text", () => {
    expect(formatMoment(new Date("2026-03-04T05:06:07Z"), "[Week] Q, h:mm A")).toBe("Week 1, 5:06 AM");
  });
});
