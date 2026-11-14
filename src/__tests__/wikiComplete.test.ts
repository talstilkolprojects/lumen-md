/**
 * `[[` link completion (4.5): the shared core — what is being completed,
 * matching by noteKey, headings, blocks, aliases, "create", and the edit.
 */
import { describe, expect, it } from "vitest";
import {
  frontmatterAliases,
  newNotePath,
  noteBlocks,
  noteCatalog,
  parseWikiQuery,
  suggestBlocks,
  suggestHeadings,
  suggestNotes,
  wikiEdit,
  wikiSuggestions,
  type CatalogFile,
  type WikiSuggestion,
} from "../editor/wikiComplete";

const file = (path: string, content = "", modified = 0): CatalogFile => ({ path, content, modified });

const PROJECT = `---
title: Project
aliases: [Alpha, "פרויקט אלפא"]
---
# Project Alpha

## Goals

Ship it. ^goal-1

\`\`\`md
## Not a heading
Not a block ^code
\`\`\`

- a list item ^li

> quoted

^quote
`;

const vault = () =>
  noteCatalog([
    file("Project Alpha.md", PROJECT, 5),
    file("שלום עולם.md", "# שָׁלוֹם\n", 3),
    file("work/Notes.md", "", 2),
    file("home/Notes.md", "", 1),
    file("Daily/2026-10-18.md", "", 9),
    file("data.csv", "a,b"),
  ]);

const labels = (xs: WikiSuggestion[]) => xs.map((s) => s.label);

describe("parseWikiQuery", () => {
  it("finds the open link before the caret", () => {
    expect(parseWikiQuery("See [[Proj")).toEqual({ kind: "note", open: 4, note: "Proj", text: "Proj", from: 6 });
    expect(parseWikiQuery("[[")).toMatchObject({ kind: "note", text: "", from: 2 });
    expect(parseWikiQuery("![[Emb")).toMatchObject({ kind: "note", text: "Emb" });
  });

  it("headings after #, blocks after #^ or ^", () => {
    expect(parseWikiQuery("[[Note#Go")).toMatchObject({ kind: "heading", note: "Note", text: "Go", from: 7 });
    expect(parseWikiQuery("[[#Go")).toMatchObject({ kind: "heading", note: "", text: "Go" });
    expect(parseWikiQuery("[[Note#^go")).toMatchObject({ kind: "block", note: "Note", text: "go", from: 8 });
    expect(parseWikiQuery("[[Note^go")).toMatchObject({ kind: "block", note: "Note", text: "go", from: 6, bareCaret: true });
  });

  it("nothing outside an open link, after a label or once it is closed", () => {
    expect(parseWikiQuery("plain [text")).toBeNull();
    expect(parseWikiQuery("[[Done]] and more")).toBeNull();
    expect(parseWikiQuery("[[Note|lab")).toBeNull();
    expect(parseWikiQuery("[[" + "x".repeat(201))).toBeNull();
  });
});

describe("notes", () => {
  it("matches by noteKey: niqqud, final letters and case don't matter", () => {
    expect(labels(suggestNotes(vault(), "שָׁלוֹ"))[0]).toBe("שלום עולם");
    expect(labels(suggestNotes(vault(), "שלומ עולמ"))[0]).toBe("שלום עולם");
    expect(labels(suggestNotes(vault(), "PROJECT al"))[0]).toBe("Project Alpha");
  });

  it("ranks a name start above a word start above a substring, and skips non-notes", () => {
    const c = noteCatalog([file("Somealpha.md"), file("Contains alpha.md"), file("alphabet.md"), file("Has-alpha.md"), file("a-l-p-h-a.md"), file("alpha.csv")]);
    expect(labels(suggestNotes(c, "alpha"))).toEqual(["alphabet", "Has-alpha", "Contains alpha", "Somealpha", "a-l-p-h-a"]);
  });

  it("links a shared name by its path, and shows the folder", () => {
    const notes = suggestNotes(vault(), "notes").filter((s) => s.kind === "note");
    expect(notes.map((s) => [s.insert, s.detail])).toEqual([
      ["work/Notes", "work"],
      ["home/Notes", "home"],
    ]);
    expect(suggestNotes(vault(), "proj")[0].insert).toBe("Project Alpha");
  });

  it("matches folder paths", () => {
    expect(suggestNotes(vault(), "home/no")[0]).toMatchObject({ label: "Notes", insert: "home/Notes" });
  });

  it("shows the most recently changed notes for a bare [[", () => {
    expect(labels(suggestNotes(vault(), "")).slice(0, 2)).toEqual(["2026-10-18", "Project Alpha"]);
  });

  it("offers front-matter aliases, inserted as target|alias", () => {
    const s = suggestNotes(vault(), "alp");
    expect(s[0]).toMatchObject({ kind: "alias", label: "Alpha", detail: "Project Alpha", insert: "Project Alpha|Alpha" });
    expect(suggestNotes(vault(), "פרויקט")[0]).toMatchObject({ kind: "alias", label: "פרויקט אלפא" });
  });

  it("an alias with a bracket or bar still finds the note, but isn't used as the label", () => {
    const c = noteCatalog([file("Project Alpha.md", '---\naliases: ["Project [old]", "a|b", Fine]\n---\n')]);
    expect(suggestNotes(c, "project [o")[0]).toMatchObject({ kind: "alias", label: "Project [old]", insert: "Project Alpha" });
    expect(suggestNotes(c, "a|b")[0]).toMatchObject({ kind: "alias", label: "a|b", insert: "Project Alpha" });
    expect(suggestNotes(c, "fine")[0]).toMatchObject({ kind: "alias", insert: "Project Alpha|Fine" });
  });

  it("offers to create the note when none has the typed name", () => {
    const s = suggestNotes(vault(), "Brand New", { create: true });
    expect(s).toEqual([{ kind: "create", label: "Brand New", insert: "Brand New", createPath: "Brand New.md" }]);
    // Partial matches exist: still offered, last.
    const p = suggestNotes(vault(), "Proj", { create: true });
    expect(p.at(-1)).toMatchObject({ kind: "create", createPath: "Proj.md" });
    expect(p[0].kind).not.toBe("create");
    // An exact name, path or alias: no.
    for (const q of ["project alpha", "work/notes", "alpha", "שָׁלוֹם עוֹלָם"]) expect(suggestNotes(vault(), q, { create: true }).some((x) => x.kind === "create")).toBe(false);
    // Not without a workspace, nor for a name a link can't hold.
    expect(suggestNotes(vault(), "Brand New").some((x) => x.kind === "create")).toBe(false);
    expect(suggestNotes(vault(), "a#b", { create: true }).some((x) => x.kind === "create")).toBe(false);
  });

  it("newNotePath: folders allowed; empty, dot and link-breaking names refused", () => {
    expect(newNotePath(" folder / New  note ")).toBe("folder/New note.md");
    expect(newNotePath("Note.md")).toBe("Note.md");
    for (const bad of ["", "a//b", "../x", "a|b", "a^b", "a:b", "x]"]) expect(newNotePath(bad)).toBeNull();
  });
});

describe("headings and blocks", () => {
  it("headings of a note, not inside code; matched by noteKey", () => {
    expect(labels(suggestHeadings(PROJECT, ""))).toEqual(["Project Alpha", "Goals"]);
    expect(labels(suggestHeadings(PROJECT, "go"))).toEqual(["Goals"]);
    expect(labels(suggestHeadings("# שָׁלוֹם רַב\n", "שלומ"))).toEqual(["שָׁלוֹם רַב"]);
  });

  it("a repeated heading is linked by its numbered slug, as the preview ids it", () => {
    const md = "# Setup\n\ntext\n\n## Setup\n\n## setup\n\n## Other\n\n## סיכום\n\n## סיכום\n";
    expect(suggestHeadings(md, "set")).toEqual([
      { kind: "heading", label: "Setup", insert: "Setup" },
      { kind: "heading", label: "Setup", detail: "#setup-1", insert: "setup-1" },
      { kind: "heading", label: "setup", detail: "#setup-2", insert: "setup-2" },
    ]);
    expect(suggestHeadings(md, "סיכו").map((s) => s.insert)).toEqual(["סיכום", "סיכום-1"]);
  });

  it("a heading's link-breaking characters are left out of the insert", () => {
    expect(suggestHeadings("# A | B [x]\n", "")[0]).toMatchObject({ label: "A | B [x]", insert: "A  B x" });
  });

  it("block ids with their text; an id on its own line names the block above", () => {
    expect(noteBlocks(PROJECT)).toEqual([
      { id: "goal-1", text: "Ship it." },
      { id: "li", text: "a list item" },
      { id: "quote", text: "quoted" },
    ]);
  });

  it("resolves the note part, and [[# uses the open note", () => {
    const c = vault();
    expect(labels(wikiSuggestions(parseWikiQuery("[[project alpha#")!, c))).toEqual(["Project Alpha", "Goals"]);
    expect(labels(wikiSuggestions(parseWikiQuery("[[#")!, c, { content: "# Here\n## There\n" }))).toEqual(["Here", "There"]);
    // The open note's unsaved text wins over the index.
    expect(labels(wikiSuggestions(parseWikiQuery("[[Project Alpha#")!, c, { path: "Project Alpha.md", content: "# Fresh\n" }))).toEqual(["Fresh"]);
    expect(wikiSuggestions(parseWikiQuery("[[Nope#")!, c)).toEqual([]);
  });

  it("the editor's live headings win over the note's text, for the open note only", () => {
    const c = vault();
    const current = { path: "Project Alpha.md", content: "# Stale\n", headings: () => ["Just typed"] };
    expect(labels(wikiSuggestions(parseWikiQuery("[[#")!, c, current))).toEqual(["Just typed"]);
    expect(labels(wikiSuggestions(parseWikiQuery("[[Project Alpha#")!, c, current))).toEqual(["Just typed"]);
    expect(labels(wikiSuggestions(parseWikiQuery("[[שלום עולם#")!, c, current))).toEqual(["שָׁלוֹם"]);
  });

  it("offers no block links until 4.8 can take the reader to the block", () => {
    const c = vault();
    // noteBlocks / suggestBlocks are ready; the links aren't followable yet.
    expect(labels(suggestBlocks(PROJECT, "sh"))).toEqual(["goal-1"]);
    expect(wikiSuggestions(parseWikiQuery("[[Project Alpha#^sh")!, c)).toEqual([]);
    expect(wikiSuggestions(parseWikiQuery("[[Project Alpha^li")!, c)).toEqual([]);
    expect(wikiSuggestions(parseWikiQuery("[[#^")!, c, { content: PROJECT })).toEqual([]);
  });
});

describe("frontmatterAliases", () => {
  it("reads lists, single values and the old alias key", () => {
    expect(frontmatterAliases("---\naliases:\n  - One\n  - 'Two'\ntags: [x]\n---\n")).toEqual(["One", "Two"]);
    expect(frontmatterAliases("---\naliases: [A, \"B, C\", 'it''s']\n---\n")).toEqual(["A", "B, C", "it's"]);
    expect(frontmatterAliases("---\nalias: Single # note\n---\n")).toEqual(["Single"]);
    expect(frontmatterAliases("---\naliases:\n---\n")).toEqual([]);
    expect(frontmatterAliases("no front matter\naliases: [x]")).toEqual([]);
  });
});

describe("wikiEdit", () => {
  const note: WikiSuggestion = { kind: "note", label: "Project Alpha", insert: "Project Alpha" };
  const run = (line: string, s: WikiSuggestion = note) => {
    const caret = line.indexOf("|");
    const before = line.slice(0, caret);
    const after = line.slice(caret + 1);
    const e = wikiEdit(parseWikiQuery(before)!, before, after, s);
    const text = before.slice(0, e.from) + e.insert + (before + after).slice(e.to);
    return text.slice(0, e.caret) + "|" + text.slice(e.caret);
  };

  it("closes an open link and puts the caret after it", () => {
    expect(run("See [[pro| now")).toBe("See [[Project Alpha]]| now");
  });

  it("keeps brackets closeBrackets already typed", () => {
    expect(run("See [[pro|]] now")).toBe("See [[Project Alpha]]| now");
    expect(run("See [[pro|] now")).toBe("See [[Project Alpha]]| now");
  });

  it("replaces the rest of an old target, keeping label and heading", () => {
    expect(run("[[pro|ject Bet]]")).toBe("[[Project Alpha]]|");
    expect(run("[[pro|ject|label]]")).toBe("[[Project Alpha||label]]");
    expect(run("[[pro|#Goals]]")).toBe("[[Project Alpha|#Goals]]");
  });

  it("headings and blocks", () => {
    expect(run("[[Project Alpha#go|", { kind: "heading", label: "Goals", insert: "Goals" })).toBe("[[Project Alpha#Goals]]|");
    expect(run("[[Project Alpha#Go|als]]", { kind: "heading", label: "Goals", insert: "Goals" })).toBe("[[Project Alpha#Goals]]|");
    expect(run("[[Project Alpha^go|", { kind: "block", label: "goal-1", insert: "#^goal-1" })).toBe("[[Project Alpha#^goal-1]]|");
  });

  it("an alias inside an existing label keeps that label", () => {
    const alias: WikiSuggestion = { kind: "alias", label: "Alpha", insert: "Project Alpha|Alpha" };
    expect(run("[[alp|", alias)).toBe("[[Project Alpha|Alpha]]|");
    expect(run("[[alp||mine]]", alias)).toBe("[[Project Alpha||mine]]");
    // An alias inserted without a label (it can't be one) keeps the target whole.
    const bare: WikiSuggestion = { kind: "alias", label: "Project [old]", insert: "Project Alpha" };
    expect(run("[[pro|", bare)).toBe("[[Project Alpha]]|");
    expect(run("[[pro||mine]]", bare)).toBe("[[Project Alpha||mine]]");
  });
});
