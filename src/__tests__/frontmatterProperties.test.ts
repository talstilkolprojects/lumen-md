/**
 * Plan 4.9 — the properties API writes one value and leaves every other
 * byte of the note as it was: comments, key order, quoting, blank lines,
 * Hebrew, CRLF, a BOM.
 */
import { describe, it, expect } from "vitest";
import {
  collectPropertySuggestions,
  convertValue,
  FrontmatterError,
  inferType,
  parseProperties,
  rankSuggestions,
  readProperties,
  removeProperty,
  renameProperty,
  setProperty,
  type PropertyValue,
} from "../properties/frontmatter";

const NOTE = [
  "---",
  "# A comment at the top",
  'title: "My note"   # trailing comment',
  "subtitle: 'single quoted'",
  "count: 3",
  "",
  "done: false",
  "date: 2026-10-18",
  "שם: שלום עולם",
  "tags:",
  "  - one",
  "  - \"two\"",
  "flow: [a, b]",
  "padded: [ x, y ]",
  "empty:",
  "link: \"[[Other Note]]\"",
  "nested:",
  "  deep: 1",
  "---",
  "",
  "# Body",
  "",
  "Text with --- and key: value lines.",
  "",
].join("\n");

/** `text` with exactly one substring replaced (asserting it occurs once). */
function only(text: string, from: string, to: string): string {
  expect(text.split(from).length - 1).toBe(1);
  return text.replace(from, to);
}

const CASES: Array<{ name: string; key: string; value: PropertyValue; from: string; to: string }> = [
  { name: "double-quoted text keeps its quotes and comment", key: "title", value: "Renamed", from: 'title: "My note"', to: 'title: "Renamed"' },
  { name: "single-quoted text keeps single quotes", key: "subtitle", value: "it's", from: "subtitle: 'single quoted'", to: "subtitle: 'it''s'" },
  { name: "number", key: "count", value: 42, from: "count: 3", to: "count: 42" },
  { name: "checkbox", key: "done", value: true, from: "done: false", to: "done: true" },
  { name: "date", key: "date", value: "2027-01-02", from: "date: 2026-10-18", to: "date: 2027-01-02" },
  { name: "Hebrew key and value", key: "שם", value: "בוקר טוב", from: "שם: שלום עולם", to: "שם: בוקר טוב" },
  { name: "block list keeps its style and indentation", key: "tags", value: ["one", "three"], from: '  - one\n  - "two"', to: "  - one\n  - three" },
  { name: "flow list without padding", key: "flow", value: ["a", "b", "c, d"], from: "flow: [a, b]", to: 'flow: [a, b, "c, d"]' },
  { name: "flow list with padding", key: "padded", value: ["z"], from: "padded: [ x, y ]", to: "padded: [ z ]" },
  { name: "empty value gets one", key: "empty", value: "now set", from: "empty:\n", to: "empty: now set\n" },
  { name: "link stays quoted", key: "link", value: "[[Another]]", from: '"[[Other Note]]"', to: '"[[Another]]"' },
  { name: "text that looks like a number is quoted", key: "count", value: "007", from: "count: 3", to: 'count: "007"' },
  { name: "clearing a value", key: "count", value: null, from: "count: 3", to: "count:" },
  { name: "text becomes a list", key: "count", value: ["a"], from: "count: 3", to: "count:\n  - a" },
  { name: "a list becomes text", key: "flow", value: "plain", from: "flow: [a, b]", to: "flow: plain" },
  { name: "an emptied block list", key: "tags", value: [], from: 'tags:\n  - one\n  - "two"', to: "tags: []" },
];

describe("setProperty — only the edited value changes", () => {
  it.each(CASES)("$name", ({ key, value, from, to }) => {
    expect(setProperty(NOTE, key, value)).toBe(only(NOTE, from, to));
  });

  it.each(CASES)("$name (CRLF file)", ({ key, value, from, to }) => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    expect(setProperty(crlf, key, value)).toBe(only(crlf, from.replace(/\n/g, "\r\n"), to.replace(/\n/g, "\r\n")));
  });

  it("writing the value a key already has returns the text unchanged", () => {
    for (const p of readProperties(NOTE)) if (p.editable) expect(setProperty(NOTE, p.key, p.value as PropertyValue)).toBe(NOTE);
  });

  it("a new key is appended before the closing fence, in the file's line endings", () => {
    expect(setProperty(NOTE, "new key", "x")).toBe(only(NOTE, "  deep: 1\n---", "  deep: 1\nnew key: x\n---"));
    const crlf = NOTE.replace(/\n/g, "\r\n");
    expect(setProperty(crlf, "status", ["a", "b"])).toBe(only(crlf, "  deep: 1\r\n---", "  deep: 1\r\nstatus:\r\n  - a\r\n  - b\r\n---"));
  });

  it("creates a frontmatter when the note has none, keeping a BOM", () => {
    expect(setProperty("# Hi\n", "tags", ["a"])).toBe("---\ntags:\n  - a\n---\n# Hi\n");
    expect(setProperty("﻿שלום\r\n", "done", true)).toBe("﻿---\r\ndone: true\r\n---\r\nשלום\r\n");
    expect(setProperty("---\n---\nbody", "a", 1)).toBe("---\na: 1\n---\nbody");
  });

  it("round-trips: what it writes reads back", () => {
    let t = NOTE;
    t = setProperty(t, "title", 'quote " and # hash');
    t = setProperty(t, "tags", ["x: y", "[[Link]]", "עברית"]);
    t = setProperty(t, "multi", "line one\nline two");
    const props = Object.fromEntries(readProperties(t).map((p) => [p.key, p.value]));
    expect(props.title).toBe('quote " and # hash');
    expect(props.tags).toEqual(["x: y", "[[Link]]", "עברית"]);
    expect(props.multi).toBe("line one\nline two");
    expect(t.endsWith("\n# Body\n\nText with --- and key: value lines.\n")).toBe(true);
  });

  it("refuses to write a frontmatter that doesn't parse", () => {
    const bad = "---\na: [1, 2\n---\nbody";
    expect(() => setProperty(bad, "a", 1)).toThrow(FrontmatterError);
    expect(parseProperties(bad).status).toBe("invalid");
    expect(() => setProperty("---\n{a: 1}\n---\n", "b", 1)).toThrow(FrontmatterError);
    // An opening fence without a closing one: never prepend a second block.
    const open = "---\ntitle: x\n\nbody without a closing fence\n";
    expect(parseProperties(open).status).toBe("invalid");
    expect(() => setProperty(open, "a", 1)).toThrow(FrontmatterError);
    expect(() => removeProperty(open, "title")).toThrow(FrontmatterError);
  });
});

describe("removeProperty / renameProperty", () => {
  it("removes exactly the property's lines", () => {
    expect(removeProperty(NOTE, "count")).toBe(only(NOTE, "count: 3\n", ""));
    expect(removeProperty(NOTE, "tags")).toBe(only(NOTE, 'tags:\n  - one\n  - "two"\n', ""));
    expect(removeProperty(NOTE, "title")).toBe(only(NOTE, 'title: "My note"   # trailing comment\n', ""));
    expect(removeProperty(NOTE, "empty")).toBe(only(NOTE, "empty:\n", ""));
    expect(removeProperty(NOTE, "nested")).toBe(only(NOTE, "nested:\n  deep: 1\n", ""));
    expect(removeProperty(NOTE, "absent")).toBe(NOTE);
    const crlf = NOTE.replace(/\n/g, "\r\n");
    expect(removeProperty(crlf, "שם")).toBe(only(crlf, "שם: שלום עולם\r\n", ""));
  });

  it("renames a key in place", () => {
    expect(renameProperty(NOTE, "count", "total")).toBe(only(NOTE, "count: 3", "total: 3"));
    expect(() => renameProperty(NOTE, "count", "title")).toThrow(FrontmatterError);
  });
});

describe("readProperties", () => {
  it("reads values and types in file order", () => {
    const props = readProperties(NOTE);
    expect(props.map((p) => p.key)).toEqual(["title", "subtitle", "count", "done", "date", "שם", "tags", "flow", "padded", "empty", "link", "nested"]);
    const type = Object.fromEntries(props.map((p) => [p.key, p.type]));
    expect(type).toMatchObject({ title: "text", count: "number", done: "checkbox", date: "date", tags: "list", link: "link", empty: "text" });
    expect(props.find((p) => p.key === "nested")?.editable).toBe(false);
    expect(parseProperties("no frontmatter").status).toBe("none");
  });

  it("infers types for empty well-known keys and converts between types", () => {
    expect(inferType(null, "tags")).toBe("list");
    expect(inferType(null, "created")).toBe("date");
    expect(inferType("https://example.org")).toBe("link");
    expect(convertValue("a, b", "list")).toEqual(["a", "b"]);
    expect(convertValue(["a", "b"], "text")).toBe("a, b");
    expect(convertValue("12", "number")).toBe(12);
    expect(convertValue("yes", "checkbox")).toBe(true);
    expect(convertValue("Note", "link")).toBe("[[Note]]");
  });
});

describe("vault suggestions", () => {
  it("counts keys and values (list items one by one) across notes", () => {
    const s = collectPropertySuggestions([
      { path: "a.md", content: "---\nstatus: draft\ntags: [x, y]\n---\n" },
      { path: "b.md", content: "---\nstatus: done\ntags:\n  - x\n---\n" },
      { path: "c.md", content: "---\nstatus: draft\n---\n" },
      { path: "d.png", content: "---\nstatus: binary\n---\n" },
      { path: "e.md", content: "no frontmatter" },
    ]);
    expect(rankSuggestions(s.keys)).toEqual(["status", "tags"]);
    expect(rankSuggestions(s.values.get("status"))).toEqual(["draft", "done"]);
    expect(rankSuggestions(s.values.get("tags"), ["y"])).toEqual(["x"]);
  });
});
