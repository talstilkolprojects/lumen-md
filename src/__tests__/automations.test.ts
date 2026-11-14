/**
 * No-code automations (plan W5.24): 20 golden rules, a dry run that writes
 * nothing, undo that restores every byte, and the loop guard.
 */
import { describe, it, expect } from "vitest";
import { applyPlan, fires, parseRules, plan, tagsOf, undoRun, MAX_DEPTH, type Fs, type Rule, type VaultEvent } from "../automations/engine";

const TODAY = "2026-11-12";
const dailyPath = (d: string) => `Daily/${d}.md`;

/** An in-memory vault that counts writes. */
function memFs(files: Record<string, string>): Fs & { files: Map<string, string>; writes: number } {
  const m = new Map(Object.entries(files));
  const fs = {
    files: m,
    writes: 0,
    read: async (p: string) => m.get(p) ?? null,
    write: async (p: string, t: string) => {
      fs.writes++;
      m.set(p, t);
    },
    move: async (a: string, b: string) => {
      fs.writes++;
      m.set(b, m.get(a)!);
      m.delete(a);
    },
    remove: async (p: string) => {
      fs.writes++;
      m.delete(p);
    },
  };
  return fs;
}
const view = (fs: { files: Map<string, string> }) => ({ read: (p: string) => fs.files.get(p) ?? null, exists: (p: string) => fs.files.has(p) });
const ctx = (fs: { files: Map<string, string> }, lastDaily = {}) => ({ vault: view(fs), dailyPath, today: TODAY, lastDaily });
const rule = (id: string, when: Rule["when"], ...then: Rule["then"]): Rule => ({ id, name: id, enabled: true, when, then });

const NOTE = "---\ntitle: פגישה\ntags: [work]\nstatus: open\n---\n# פגישה עם נועה\n\nסיכום.\n";
const changed = (path: string, before: string, after: string): VaultEvent => ({ kind: "changed", path, before, after });

interface Golden {
  name: string;
  rules: Rule[];
  files: Record<string, string>;
  event: VaultEvent;
  /** Expected files after the run (only the ones that change or appear; null = gone). */
  expect: Record<string, string | null>;
}

const goldens: Golden[] = [
  { name: "01 created in Inbox → tag inbox", rules: [rule("r", { kind: "created", folder: "Inbox" }, { kind: "tag", tag: "inbox" })], files: { "Inbox/רעיון.md": "רעיון חדש\n" }, event: { kind: "created", path: "Inbox/רעיון.md", text: "רעיון חדש\n" }, expect: { "Inbox/רעיון.md": "---\ntags:\n  - inbox\n---\nרעיון חדש\n" } },
  { name: "02 created elsewhere → nothing", rules: [rule("r", { kind: "created", folder: "Inbox" }, { kind: "tag", tag: "inbox" })], files: { "Notes/a.md": "a\n" }, event: { kind: "created", path: "Notes/a.md", text: "a\n" }, expect: {} },
  { name: "03 created anywhere → append to daily (new daily note)", rules: [rule("r", { kind: "created" }, { kind: "appendDaily", text: "- נוצר {{link}}" })], files: { "a.md": "x" }, event: { kind: "created", path: "a.md", text: "x" }, expect: { "Daily/2026-11-12.md": "- נוצר [[a]]\n" } },
  { name: "04 append to an existing daily note keeps it", rules: [rule("r", { kind: "created" }, { kind: "appendDaily", text: "- {{title}}" })], files: { "b.md": "x", "Daily/2026-11-12.md": "# היום\n\n- קודם\n" }, event: { kind: "created", path: "b.md", text: "x" }, expect: { "Daily/2026-11-12.md": "# היום\n\n- קודם\n- b\n" } },
  { name: "05 tag added (frontmatter) → move to Projects", rules: [rule("r", { kind: "tagAdded", tag: "project" }, { kind: "move", folder: "Projects" })], files: { "x.md": "---\ntags: [project]\n---\n" }, event: changed("x.md", "---\ntags: []\n---\n", "---\ntags: [project]\n---\n"), expect: { "x.md": null, "Projects/x.md": "---\ntags: [project]\n---\n" } },
  { name: "06 tag added (inline #tag) → tag done in frontmatter", rules: [rule("r", { kind: "tagAdded", tag: "#urgent" }, { kind: "tag", tag: "triage" })], files: { "y.md": NOTE + "\n#urgent\n" }, event: changed("y.md", NOTE, NOTE + "\n#urgent\n"), expect: { "y.md": NOTE.replace("tags: [work]", "tags: [work, triage]") + "\n#urgent\n" } },
  { name: "07 a tag that was already there does not fire", rules: [rule("r", { kind: "tagAdded", tag: "work" }, { kind: "tag", tag: "x" })], files: { "z.md": NOTE + "edit\n" }, event: changed("z.md", NOTE, NOTE + "edit\n"), expect: {} },
  { name: "08 property changed to a value → move to Archive", rules: [rule("r", { kind: "propertyChanged", key: "status", value: "done" }, { kind: "move", folder: "Archive" })], files: { "Work/m.md": NOTE.replace("open", "done") }, event: changed("Work/m.md", NOTE, NOTE.replace("open", "done")), expect: { "Work/m.md": null, "Archive/m.md": NOTE.replace("open", "done") } },
  { name: "09 property changed to another value → nothing", rules: [rule("r", { kind: "propertyChanged", key: "status", value: "done" }, { kind: "move", folder: "Archive" })], files: { "m.md": NOTE.replace("open", "waiting") }, event: changed("m.md", NOTE, NOTE.replace("open", "waiting")), expect: {} },
  { name: "10 property changed (any value) → append to daily", rules: [rule("r", { kind: "propertyChanged", key: "status" }, { kind: "appendDaily", text: "- {{link}}: סטטוס השתנה" })], files: { "m.md": NOTE.replace("open", "x") }, event: changed("m.md", NOTE, NOTE.replace("open", "x")), expect: { "Daily/2026-11-12.md": "- [[m]]: סטטוס השתנה\n" } },
  { name: "11 template applied to a new meeting note", rules: [rule("r", { kind: "created", folder: "Meetings" }, { kind: "template", template: "Templates/meeting.md" })], files: { "Meetings/q.md": "# q\n", "Templates/meeting.md": "---\ntype: meeting\ndate: \"{{date}}\"\n---\n## משתתפים\n\n## החלטות\n" }, event: { kind: "created", path: "Meetings/q.md", text: "# q\n" }, expect: { "Meetings/q.md": "---\ntype: meeting\ndate: 2026-11-12\n---\n# q\n\n## משתתפים\n\n## החלטות\n" } },
  { name: "12 a template's key the note already has keeps the note's value", rules: [rule("r", { kind: "created" }, { kind: "template", template: "T.md" })], files: { "n.md": "---\ntype: idea\n---\nx\n", "T.md": "---\ntype: meeting\n---\n" }, event: { kind: "created", path: "n.md", text: "---\ntype: idea\n---\nx\n" }, expect: {} },
  { name: "13 daily → append a line", rules: [rule("d", { kind: "daily" }, { kind: "appendDaily", text: "## יומן {{date}}" })], files: {}, event: { kind: "daily", date: TODAY }, expect: { "Daily/2026-11-12.md": "## יומן 2026-11-12\n" } },
  { name: "14 daily already ran today → nothing", rules: [rule("d", { kind: "daily" }, { kind: "appendDaily", text: "x" })], files: {}, event: { kind: "daily", date: TODAY }, expect: {} },
  { name: "15 disabled rule → nothing", rules: [{ ...rule("r", { kind: "created" }, { kind: "tag", tag: "x" }), enabled: false }], files: { "a.md": "a" }, event: { kind: "created", path: "a.md", text: "a" }, expect: {} },
  { name: "16 two actions: tag, then move", rules: [rule("r", { kind: "created", folder: "Inbox" }, { kind: "tag", tag: "filed" }, { kind: "move", folder: "Notes" })], files: { "Inbox/k.md": "k\n" }, event: { kind: "created", path: "Inbox/k.md", text: "k\n" }, expect: { "Inbox/k.md": null, "Notes/k.md": "---\ntags:\n  - filed\n---\nk\n" } },
  { name: "17 move to a folder with the same name → numbered", rules: [rule("r", { kind: "created", folder: "Inbox" }, { kind: "move", folder: "Notes" })], files: { "Inbox/k.md": "new\n", "Notes/k.md": "old\n" }, event: { kind: "created", path: "Inbox/k.md", text: "new\n" }, expect: { "Inbox/k.md": null, "Notes/k 2.md": "new\n" } },
  { name: "18 a chain: tag → move → the move's 'created' tags again", rules: [rule("a", { kind: "tagAdded", tag: "done" }, { kind: "move", folder: "Done" }), rule("b", { kind: "created", folder: "Done" }, { kind: "tag", tag: "archived" })], files: { "t.md": "#done\n" }, event: changed("t.md", "x\n", "#done\n"), expect: { "t.md": null, "Done/t.md": "---\ntags:\n  - archived\n---\n#done\n" } },
  { name: "19 two rules that undo each other stop (loop guard)", rules: [rule("a", { kind: "tagAdded", tag: "a" }, { kind: "move", folder: "A" }), rule("b", { kind: "created", folder: "A" }, { kind: "move", folder: "B" }), rule("c", { kind: "created", folder: "B" }, { kind: "move", folder: "A" })], files: { "l.md": "#a\n" }, event: changed("l.md", "", "#a\n"), expect: { "l.md": null, "A/l.md": "#a\n" } },
  { name: "20 the daily line is not added twice", rules: [rule("r", { kind: "created" }, { kind: "appendDaily", text: "- {{link}}" })], files: { "c.md": "c", "Daily/2026-11-12.md": "- [[c]]\n" }, event: { kind: "created", path: "c.md", text: "c" }, expect: {} },
];

describe("20 golden rules (W5.24)", () => {
  for (const g of goldens) {
    it(g.name, async () => {
      const fs = memFs(g.files);
      const before = new Map(fs.files);
      const p = plan(g.rules, g.event, ctx(fs, g.name.startsWith("14") ? { d: TODAY } : {}));
      // The dry run is the plan: nothing was written.
      expect(fs.writes).toBe(0);
      expect(fs.files).toEqual(before);
      const entry = await applyPlan(p, fs, "run-1", g.name, new Date("2026-11-12T10:00:00Z"));
      const after: Record<string, string | null> = {};
      for (const k of new Set([...before.keys(), ...fs.files.keys()])) if (before.get(k) !== fs.files.get(k)) after[k] = fs.files.get(k) ?? null;
      expect(after).toEqual(g.expect);
      // Undo puts every byte back.
      expect(await undoRun(entry, fs)).toEqual({ ok: true });
      expect(fs.files).toEqual(before);
    });
  }
  it("has 20", () => expect(goldens).toHaveLength(20));
});

describe("loop guard and undo safety (W5.24)", () => {
  it("a rule fires at most once per note in one cascade, and the cascade stops at MAX_DEPTH", () => {
    const fs = memFs({ "l.md": "#a\n" });
    const rules = [rule("a", { kind: "tagAdded", tag: "a" }, { kind: "move", folder: "A" }), rule("b", { kind: "created", folder: "A" }, { kind: "move", folder: "B" }), rule("c", { kind: "created", folder: "B" }, { kind: "move", folder: "A" })];
    const p = plan(rules, changed("l.md", "", "#a\n"), ctx(fs));
    expect(p.fired.map((f) => f.rule)).toEqual(["a", "b", "c"]);
    expect(p.stopped.length).toBeGreaterThan(0);
    expect(Math.max(...p.fired.map((f) => f.depth))).toBeLessThan(MAX_DEPTH);
  });

  it("refuses to undo over an edit made after the run", async () => {
    const fs = memFs({ "Inbox/a.md": "a\n" });
    const p = plan([rule("r", { kind: "created", folder: "Inbox" }, { kind: "tag", tag: "x" })], { kind: "created", path: "Inbox/a.md", text: "a\n" }, ctx(fs));
    const entry = await applyPlan(p, fs, "1", "e", new Date());
    await fs.write("Inbox/a.md", "edited by hand\n");
    expect(await undoRun(entry, fs)).toEqual({ ok: false, path: "Inbox/a.md" });
    expect(fs.files.get("Inbox/a.md")).toBe("edited by hand\n");
  });

  it("reads tags from frontmatter and text, not from code", () => {
    expect([...tagsOf("---\ntags: [A, b]\n---\n#עברית and `#code`\n```\n#no\n```\n")].sort()).toEqual(["a", "b", "עברית"]);
  });

  it("parses the rules file and skips what is not a rule", () => {
    expect(parseRules('{"rules":[{"id":"x","name":"x","enabled":true,"when":{"kind":"daily"},"then":[]},{"bad":1}]}').map((r) => r.id)).toEqual(["x"]);
    expect(parseRules("not json")).toEqual([]);
  });

  it("a daily rule fires once a day", () => {
    const r = rule("d", { kind: "daily" }, { kind: "appendDaily", text: "x" });
    expect(fires(r, { kind: "daily", date: TODAY }, { today: TODAY, lastDaily: {} })).toBe(true);
    expect(fires(r, { kind: "daily", date: TODAY }, { today: TODAY, lastDaily: { d: TODAY } })).toBe(false);
  });
});
