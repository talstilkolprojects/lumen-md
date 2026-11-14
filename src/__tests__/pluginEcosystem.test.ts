/**
 * The ten registry plugins of plan W4.32, each through the plugin test kit
 * (the sandbox's rules in Node: the same method table, default-deny
 * capabilities), each passing the registry scan with nothing undeclared or
 * unused, and the registry index built from the folders.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadPlugin } from "../../packages/create-lumen-plugin/template/tools/testkit.mjs";
import { scanPluginVersion } from "../plugins/runtime/scan";

const DIR = resolve(__dirname, "../../public/plugins/examples");
const ex = (name: string) => join(DIR, name);
const TEN = ["calendar", "flashcards", "kanban", "linter", "natural-dates", "note-refactor", "sort-lines", "table-format", "tags", "templates"];

type Tree = { type: string; direction?: string; text?: string; label?: string; target?: string; children?: Tree[]; items?: Tree[][]; id?: string };
const texts = (t: Tree | null | undefined): string[] => {
  if (!t) return [];
  const own = [t.text, t.label].filter((x): x is string => typeof x === "string");
  return [...own, ...(t.children ?? []).flatMap(texts), ...(t.items ?? []).flat().flatMap(texts)];
};
const find = (t: Tree | null | undefined, pred: (n: Tree) => boolean): Tree[] => (!t ? [] : [...(pred(t) ? [t] : []), ...(t.children ?? []).flatMap((c) => find(c, pred)), ...(t.items ?? []).flat().flatMap((c) => find(c, pred))]);

describe("the registry (W4.32)", () => {
  const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as { plugins: { id: string; versions: { version: string; path: string; sha256: string }[] }[] };
  const scan = JSON.parse(readFileSync(join(DIR, "scan.json"), "utf8")) as { results: { id: string; version: string; passed: boolean; grade: string; findings: { rule: string }[]; sha256: string }[] };

  it("lists every plugin folder once, with the code's SHA-256 the scan saw", () => {
    const folders = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(index.plugins.flatMap((p) => p.versions.map((v) => v.path)).sort()).toEqual(folders);
    for (const name of TEN) expect(folders).toContain(name);
    for (const p of index.plugins)
      for (const v of p.versions) {
        const r = scan.results.find((x) => x.id === p.id && x.version === v.version);
        expect(r?.sha256, `${p.id}@${v.version}`).toBe(v.sha256);
      }
  });

  it("every version passed its scan, with only the 'unsigned' note", () => {
    expect(scan.results).toHaveLength(index.plugins.reduce((n, p) => n + p.versions.length, 0));
    for (const r of scan.results) {
      expect(r.passed, r.id).toBe(true);
      expect(r.findings.map((f) => f.rule), r.id).toEqual(["unsigned"]);
    }
  });

  for (const name of TEN) {
    it(`${name}: the scan of the files on disk passes; nothing undeclared, nothing unused`, async () => {
      const manifest = readFileSync(join(ex(name), "lumen-plugin.json"), "utf8");
      const main = readFileSync(join(ex(name), "main.js"), "utf8");
      const r = await scanPluginVersion({ manifest, main });
      expect(r.passed).toBe(true);
      expect(r.findings.map((f) => f.rule)).toEqual(["unsigned"]);
      expect(r.used.sort()).toEqual((JSON.parse(manifest) as { capabilities: { id: string }[] }).capabilities.map((c) => c.id).sort());
      expect(JSON.parse(manifest).license).toBe("MIT");
    });
  }

  it("the plugins use nothing QuickJS lacks (no Intl, no locale-dependent formatting) and no network", () => {
    for (const name of TEN) {
      const main = readFileSync(join(ex(name), "main.js"), "utf8");
      expect(/\bIntl\b|toLocale(?:Date|Time)?String|toLocale(?:Upper|Lower)Case|localeCompare/.test(main.replace(/^\s*\/\/.*$/gm, "")), name).toBe(false);
      expect(/network/.test(readFileSync(join(ex(name), "lumen-plugin.json"), "utf8")), name).toBe(false);
    }
  });
});

describe("templates", () => {
  const vault = {
    "Templates/Lecture.md": "---\ntags: [lecture]\n---\n# {{title}}\n{{hebrewWeekday}}, {{date:DD/MM/YYYY}} {{time}}\n{{selection}}\n{{unknown}}",
    "Templates/Daily.md": "## {{date}} ({{weekday}})",
  };
  it("asks which template when there are several, then fills it in at the cursor", async () => {
    const p = await loadPlugin({ dir: ex("templates"), vault, document: { text: "", fileName: "courses/Algorithms.md" } });
    await p.run("insert", { now: "2026-11-13T09:05:00" });
    expect(texts(p.panel.tree as Tree)).toEqual(["Templates", "Daily", "Lecture"]);
    await p.emit("ui:panel", { id: "t1", kind: "click" });
    expect(p.document.text).toBe("---\ntags: [lecture]\n---\n# Algorithms\nיום שישי, 13/11/2026 09:05\n\n{{unknown}}");
    expect(p.panel.open).toBe(false);
  });
  it("replaces the selection, skips the template's front matter when the note has one, and uses a set folder", async () => {
    const p = await loadPlugin({ dir: ex("templates"), vault: { "My/T.md": "---\na: 1\n---\n> {{selection}} — {{date:[week of] D MMMM}}" }, settings: { folder: "My" }, document: { text: "---\nb: 2\n---\nquote", fileName: "n.md" } });
    p.select(13, 18);
    await p.run("insert", { now: "2026-02-01T12:00:00" });
    expect(p.document.text).toBe("---\nb: 2\n---\n> quote — week of 1 February");
  });
  it("without templates: a hint in the panel, in English and Hebrew; without a vault grant: denied", async () => {
    const p = await loadPlugin({ dir: ex("templates") });
    await p.run("insert");
    expect(texts(p.panel.tree as Tree).join(" ")).toMatch(/No templates in “Templates”.*אין תבניות/);
    const q = await loadPlugin({ dir: ex("templates"), vault, grants: ["commands", "document:read", "document:write", "panel", "settings"] });
    await q.run("insert");
    expect([...q.denied.keys()]).toEqual(["vault:read"]);
    expect(q.document.text).toBe("");
  });
});

describe("kanban", () => {
  const board = "## לעשות\n- לכתוב סיכום [[שיעור 3]]\n- קריאה\n## בתהליך\n- תרגיל 2\n## בוצע\n- [x] תרגיל 1";
  it("draws columns with counts, note links and done marks", async () => {
    const p = await loadPlugin({ dir: ex("kanban") });
    expect([...p.renderers]).toEqual(["kanban"]);
    const tree = (await p.render("kanban", board)) as Tree;
    expect(tree.direction).toBe("row");
    expect(find(tree, (n) => n.type === "heading").map((h) => h.text)).toEqual(["לעשות (2)", "בתהליך (1)", "בוצע (1)"]);
    expect(find(tree, (n) => n.type === "noteLink")[0]).toEqual({ type: "noteLink", target: "שיעור 3", label: "שיעור 3" });
    expect(texts(tree)).toContain("✓ ");
  });
  it("exports the first board of the note as a Markdown table to the clipboard", async () => {
    const p = await loadPlugin({ dir: ex("kanban"), document: { text: `intro\n\n\`\`\`kanban\n${board}\n\`\`\`\n` } });
    await p.run("export");
    expect(p.clipboard).toBe("| לעשות | בתהליך | בוצע |\n| --- | --- | --- |\n| לכתוב סיכום [[שיעור 3]] | תרגיל 2 | ✓ תרגיל 1 |\n| קריאה |  |  |\n");
    const q = await loadPlugin({ dir: ex("kanban"), document: { text: "no board" } });
    await q.run("export");
    expect(q.clipboard).toBe(null);
    expect(q.notifications[0].kind).toBe("info");
  });
  it("inserts a new board at the cursor", async () => {
    const p = await loadPlugin({ dir: ex("kanban"), document: { text: "x" } });
    p.select(1);
    await p.run("new");
    expect(p.document.text.startsWith("x```kanban\n## To do")).toBe(true);
  });
});

describe("calendar", () => {
  const vault = { "Daily/2026-11-01.md": "a", "Daily/2026/2026-11-12.md": "b", "Daily/2026-10-31.md": "c", "Daily/notes.md": "d", "2026-11-05.md": "root" };
  it("shows the month with links to the days that have a note, week starting Sunday", async () => {
    const p = await loadPlugin({ dir: ex("calendar"), vault, settings: { folder: "Daily" } });
    await p.run("show", { today: "2026-11-12" });
    const tree = p.panel.tree as Tree;
    expect(texts(tree)[0]).toBe("November 2026 · נובמבר");
    expect(find(tree, (n) => n.type === "noteLink").map((n) => [n.target, n.label])).toEqual([["Daily/2026-11-01", "1"], ["Daily/2026/2026-11-12", "[12]"]]);
    // 1 Nov 2026 is a Sunday: the first row starts with it.
    const firstWeek = find(tree, (n) => n.type === "box" && n.direction === "row" && (n.children ?? []).length === 7)[0];
    expect(firstWeek.children![0].type).toBe("noteLink");
    expect(texts(tree)).toContain("2 daily notes this month · 2 פתקים יומיים החודש");
  });
  it("moves between months and keeps the week-start setting with the folder", async () => {
    const p = await loadPlugin({ dir: ex("calendar"), vault, settings: { folder: "Daily" } });
    await p.run("show", { today: "2026-11-12" });
    await p.emit("ui:panel", { id: "prev", kind: "click" });
    expect(texts(p.panel.tree as Tree)[0]).toBe("October 2026 · אוקטובר");
    expect(find(p.panel.tree as Tree, (n) => n.type === "noteLink").map((n) => n.target)).toEqual(["Daily/2026-10-31"]);
    await p.emit("ui:panel", { id: "weekStart", kind: "change", value: "1" });
    expect(p.settings).toEqual({ folder: "Daily", weekStart: 1 });
    const firstWeek = find(p.panel.tree as Tree, (n) => n.type === "box" && n.direction === "row" && (n.children ?? []).length === 7)[0];
    // 1 Oct 2026 is a Thursday: with Monday first, three blanks lead.
    expect(firstWeek.children!.slice(0, 4).map((c) => c.text)).toEqual(["·", "·", "·", "1"]);
    await p.emit("ui:panel", { id: "next", kind: "click" });
    await p.emit("ui:panel", { id: "next", kind: "click" });
    expect(texts(p.panel.tree as Tree)[0]).toBe("December 2026 · דצמבר");
  });
});

describe("table-format", () => {
  it("lines up every table outside code, keeping alignments, measuring niqqud as zero width", async () => {
    const text = "| שם | ציון |\n|:--|--:|\n| שָׁלוֹם | 9 |\n| Bob \\| B | 100 |\n\n```\n|a|b|\n|-|-|\n```\n";
    const p = await loadPlugin({ dir: ex("table-format"), document: { text } });
    await p.run("format");
    expect(p.document.text).toBe("| שם       | ציון |\n| :------- | ---: |\n| שָׁלוֹם     |    9 |\n| Bob \\| B |  100 |\n\n```\n|a|b|\n|-|-|\n```\n");
  });
  it("sorts the table under the cursor by the cursor's column: numbers by value, Hebrew by letters", async () => {
    // Final letters sort as their regular forms: ךב (= כב) after כא; by code point it would come first.
    const text = "| a | n |\n|---|---|\n| ךב | 10 |\n| כא | 9 |\n| א | 100 |\n";
    const p = await loadPlugin({ dir: ex("table-format"), document: { text } });
    p.select(text.indexOf("| 10") + 2);
    await p.run("sort-asc");
    expect(p.document.text.split("\n").slice(2, 5).map((l) => l.split("|")[2].trim())).toEqual(["9", "10", "100"]);
    p.select(3);
    await p.run("sort-desc");
    expect(p.document.text.split("\n").slice(2, 5).map((l) => l.split("|")[1].trim())).toEqual(["ךב", "כא", "א"]);
  });
});

describe("linter", () => {
  it("fixes spacing, headings, bullets and the final newline, but not code or front matter", async () => {
    const text = "---\ntitle:  x  \n---\n#Title\ntext   \nhard break  \n\n\n\n* one\n+ two\n```\n*  keep   \n\n\n```\n## Next\nend";
    const p = await loadPlugin({ dir: ex("linter"), document: { text } });
    await p.run("lint");
    expect(p.document.text).toBe("---\ntitle:  x  \n---\n\n# Title\n\ntext\nhard break  \n\n* one\n* two\n```\n*  keep   \n\n\n```\n\n## Next\n\nend\n");
    expect(p.notifications[0].kind).toBe("success");
    expect(p.notifications[0].text).toMatch(/^Fixed \d+ things\. · תוקנו \d+\.$/);
  });
  it("a tidy note is left alone; a rule can be turned off", async () => {
    const p = await loadPlugin({ dir: ex("linter"), document: { text: "# A\n\n- b\n" } });
    await p.run("lint");
    expect(p.calls.some((c) => c.method === "document.setText")).toBe(false);
    expect(p.notifications[0].text).toBe("Nothing to fix. · אין מה לתקן.");
    const q = await loadPlugin({ dir: ex("linter"), settings: { off: ["final-newline"] }, document: { text: "a" } });
    await q.run("lint");
    expect(q.document.text).toBe("a");
  });
});

describe("tags", () => {
  const vault = {
    "a.md": "---\ntags: [קורס/מתמטיקה, draft]\n---\nטקסט #קורס/מתמטיקה וגם #idea\n`#notatag` [link](https://x.example/p#frag) [[Note#Heading]]",
    "b.md": "---\ntags:\n  - draft\n---\n# Heading not a tag\n#idea and #קורס",
    "dir/c.md": "```\n#incode\n```\n#idea",
  };
  it("lists every tag with its note count (front matter and inline, Hebrew, not code, links or headings)", async () => {
    const p = await loadPlugin({ dir: ex("tags"), vault });
    await p.run("show");
    const list = find(p.panel.tree as Tree, (n) => n.type === "list")[0];
    expect(texts(list)).toEqual(["#idea — 3", "#draft — 2", "#קורס — 1", "#קורס/מתמטיקה — 1"]);
  });
  it("renames a tag and its nested tags everywhere, leaving code alone", async () => {
    const p = await loadPlugin({ dir: ex("tags"), vault });
    await p.run("show");
    await p.emit("ui:panel", { id: "tag", kind: "change", value: "קורס" });
    await p.emit("ui:panel", { id: "to", kind: "change", value: "#לימודים" });
    await p.emit("ui:panel", { id: "rename", kind: "click" });
    expect(p.vault.get("a.md")).toBe("---\ntags: [לימודים/מתמטיקה, draft]\n---\nטקסט #לימודים/מתמטיקה וגם #idea\n`#notatag` [link](https://x.example/p#frag) [[Note#Heading]]");
    expect(p.vault.get("b.md")).toBe("---\ntags:\n  - draft\n---\n# Heading not a tag\n#idea and #לימודים");
    expect(p.vault.get("dir/c.md")).toBe(vault["dir/c.md"]);
    expect(p.notifications.at(-1)!.text).toContain("in 2 notes");
  });
  it("refuses a name that is not a tag", async () => {
    const p = await loadPlugin({ dir: ex("tags"), vault });
    await p.run("show");
    await p.emit("ui:panel", { id: "tag", kind: "change", value: "idea" });
    await p.emit("ui:panel", { id: "to", kind: "change", value: "two words" });
    await p.emit("ui:panel", { id: "rename", kind: "click" });
    expect(p.notifications.at(-1)!.kind).toBe("error");
    expect(p.calls.some((c) => c.method === "vault.write")).toBe(false);
  });
});

describe("flashcards", () => {
  const text = "# אוצר מילים\n- dog :: כלב\nחתול :: cat\n```\nnot :: a card\n```\n";
  it("reviews the due cards, schedules them with SM-2, and brings 'again' back at the end", async () => {
    const p = await loadPlugin({ dir: ex("flashcards"), document: { text } });
    await p.run("review", { today: "2026-11-12" });
    expect(texts(p.panel.tree as Tree)).toContain("dog");
    await p.emit("ui:panel", { id: "show", kind: "click" });
    expect(texts(p.panel.tree as Tree)).toContain("כלב");
    await p.emit("ui:panel", { id: "g4", kind: "click" });
    expect(texts(p.panel.tree as Tree)).toContain("חתול");
    await p.emit("ui:panel", { id: "show", kind: "click" });
    await p.emit("ui:panel", { id: "g0", kind: "click" });
    expect(texts(p.panel.tree as Tree)).toContain("חתול");
    await p.emit("ui:panel", { id: "show", kind: "click" });
    await p.emit("ui:panel", { id: "g5", kind: "click" });
    expect(texts(p.panel.tree as Tree)[0]).toBe("Done: 2 reviewed · סיימתם: 2");
    const states = [...p.storage.values()] as { reps: number; interval: number; ease: number; due: number }[];
    expect(states.map((s) => s.interval).sort()).toEqual([1, 1]);
    expect(p.document.text).toBe(text);
    // Tomorrow both are due again; today none.
    const q = await loadPlugin({ dir: ex("flashcards"), document: { text }, storage: Object.fromEntries(p.storage) });
    await q.run("review", { today: "2026-11-12" });
    expect(texts(q.panel.tree as Tree)[0]).toBe("No cards due · אין כרטיסים לחזרה");
    await q.run("review", { today: "2026-11-13" });
    expect(texts(q.panel.tree as Tree)[0]).toBe("2 due · 2 לחזרה");
  });
  it("intervals grow 1 → 6 → 15 days with 'good', and the note is only read", async () => {
    const p = await loadPlugin({ dir: ex("flashcards"), document: { text: "q :: a" } });
    const days = ["2026-01-01", "2026-01-02", "2026-01-08"];
    const intervals: number[] = [];
    for (const d of days) {
      await p.run("review", { today: d });
      await p.emit("ui:panel", { id: "show", kind: "click" });
      await p.emit("ui:panel", { id: "g4", kind: "click" });
      intervals.push(([...p.storage.values()][0] as { interval: number }).interval);
    }
    expect(intervals).toEqual([1, 6, 15]);
    expect(p.calls.every((c) => !c.method.startsWith("document.set") && !c.method.startsWith("vault."))).toBe(true);
  });
});

describe("note-refactor", () => {
  it("extracts the selection to a new note in the same folder, named from its heading, and links it", async () => {
    const text = "intro\n## מבוא לגרפים\nצמתים וקשתות.\nend";
    const p = await loadPlugin({ dir: ex("note-refactor"), document: { text, fileName: "courses/Algo.md" }, vault: { "courses/מבוא לגרפים.md": "taken" } });
    p.select(6, text.indexOf("end"));
    await p.run("extract");
    expect(p.vault.get("courses/מבוא לגרפים 2.md")).toBe("# מבוא לגרפים 2\n\nצמתים וקשתות.\n");
    expect(p.vault.get("courses/מבוא לגרפים.md")).toBe("taken");
    expect(p.document.text).toBe("intro\n[[מבוא לגרפים 2]]\nend");
  });
  it("splits a note by headings, keeping what lies outside the sections and code untouched", async () => {
    const text = "# Course\nintro\n## One\na\n```\n## not a heading\n```\n## Two: a/b?\nb\n# Appendix\nz";
    const p = await loadPlugin({ dir: ex("note-refactor"), document: { text, fileName: "Course.md" } });
    await p.run("split");
    expect(p.vault.get("One.md")).toBe("# One\n\na\n```\n## not a heading\n```\n");
    expect(p.vault.get("Two a b.md")).toBe("# Two a b\n\nb\n");
    expect(p.document.text).toBe("# Course\nintro\n- [[One]]\n- [[Two a b]]\n# Appendix\nz");
  });
  it("without a selection it says so and writes nothing", async () => {
    const p = await loadPlugin({ dir: ex("note-refactor"), document: { text: "abc" } });
    await p.run("extract");
    expect(p.vault.size).toBe(0);
    expect(p.notifications[0].kind).toBe("info");
  });
});

describe("natural-dates", () => {
  // Thursday 12 November 2026.
  const cases: [string, string][] = [
    ["today", "2026-11-12"],
    ["מחר", "2026-11-13"],
    ["מחרתיים", "2026-11-14"],
    ["אתמול", "2026-11-11"],
    ["next friday", "2026-11-13"],
    ["Thursday", "2026-11-19"],
    ["last monday", "2026-11-09"],
    ["יום שישי הבא", "2026-11-13"],
    ["ביום ראשון", "2026-11-15"],
    ["שבת שעבר", "2026-11-07"],
    ["in 3 days", "2026-11-15"],
    ["2 weeks from now", "2026-11-26"],
    ["a week ago", "2026-11-05"],
    ["in 1 month", "2026-12-12"],
    ["בעוד שבוע", "2026-11-19"],
    ["בעוד שבועיים", "2026-11-26"],
    ["בעוד שלושה ימים", "2026-11-15"],
    ["בעוד חודש", "2026-12-12"],
    ["לפני יומיים", "2026-11-10"],
    ["13/11/2026", "2026-11-13"],
    ["1.12.26", "2026-12-01"],
    ["25/12", "2026-12-25"],
    ["2027-01-31", "2027-01-31"],
  ];
  it("turns English and Hebrew words into the right day (day-first dates)", async () => {
    for (const [words, iso] of cases) {
      const p = await loadPlugin({ dir: ex("natural-dates"), document: { text: words } });
      p.select(0, words.length);
      await p.run("convert", { today: "2026-11-12" });
      expect(p.document.text, words).toBe(`[[${iso}]]`);
    }
  });
  it("plain dates by setting; unknown words are left with a note; today's date", async () => {
    const p = await loadPlugin({ dir: ex("natural-dates"), settings: { links: false }, document: { text: "x" } });
    p.select(1);
    await p.run("today", { today: "2026-11-12" });
    expect(p.document.text).toBe("x2026-11-12");
    const q = await loadPlugin({ dir: ex("natural-dates"), document: { text: "someday" } });
    q.select(0, 7);
    await q.run("convert", { today: "2026-11-12" });
    expect(q.document.text).toBe("someday");
    expect(q.notifications[0].text).toContain("is not a date I know");
  });
});

describe("sort-lines", () => {
  it("sorts the selected lines by Hebrew letters, numbers by value, with sub-items following their item", async () => {
    const block = "- תפוח\n- ענב\n  - ירוק\n- אגס\n- item 10\n- item 2\n- ך\n- כא";
    const text = `before\n${block}\nafter`;
    const p = await loadPlugin({ dir: ex("sort-lines"), document: { text } });
    p.select(7 + 2, 7 + block.length - 1);
    await p.run("sort-asc");
    expect(p.document.text).toBe("before\n- item 2\n- item 10\n- אגס\n- ך\n- כא\n- ענב\n  - ירוק\n- תפוח\nafter");
  });
  it("reverse, by length, and remove duplicates (counting what went)", async () => {
    const p = await loadPlugin({ dir: ex("sort-lines"), document: { text: "bb\na\nbb\nccc" } });
    p.select(0, 11);
    await p.run("unique");
    expect(p.document.text).toBe("bb\na\nccc");
    expect(p.notifications[0].text).toBe("Removed 1 duplicate lines. · הוסרו 1 שורות כפולות.");
    p.select(0, 8);
    await p.run("sort-length");
    expect(p.document.text).toBe("a\nbb\nccc");
    p.select(0, 8);
    await p.run("reverse");
    expect(p.document.text).toBe("ccc\nbb\na");
  });
  it("needs a selection", async () => {
    const p = await loadPlugin({ dir: ex("sort-lines"), document: { text: "b\na" } });
    await p.run("sort-asc");
    expect(p.document.text).toBe("b\na");
    expect(p.notifications[0].kind).toBe("info");
  });
});
