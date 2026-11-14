/** Plan 4.13 — tasks across the vault: obsidian-tasks syntax and queries. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDetails, parseTaskLine, serializeTask, tasksInNote, toggleTask, type Task } from "../tasks/taskParser";
import { parseDate, parseQuery, runQuery } from "../tasks/taskQuery";

const today = new Date(2026, 9, 24);

describe("task line syntax (obsidian-tasks DefaultTaskSerializer)", () => {
  it("reads every field, in any order, from the end", () => {
    const t = parseTaskLine("- [ ] Pay rent #home ⏫ 🔁 every month 🛫 2026-10-01 ⏳ 2026-10-20 📅 2026-10-25 ➕ 2026-09-30 🆔 rent1 ⛔ a1, b2 ^blk-1", "a.md", 4)!;
    expect(t).toMatchObject({ status: "TODO", description: "Pay rent #home", priority: "high", recurrence: "every month", start: "2026-10-01", scheduled: "2026-10-20", due: "2026-10-25", created: "2026-09-30", id: "rent1", dependsOn: ["a1", "b2"], tags: ["#home"], blockLink: "^blk-1", line: 4 });
  });

  it("keeps tags mixed with fields in the description (upstream trailing-tags rule)", () => {
    expect(parseDetails("Do something #tag1 📅 2026-10-25 #tag2").description).toBe("Do something #tag1 #tag2");
  });

  it("accepts the alternative emojis and Variation Selector 16", () => {
    expect(parseDetails("⌛ 2021-06-20").scheduled).toBe("2021-06-20");
    expect(parseDetails("📆 2021-06-20").due).toBe("2021-06-20");
    expect(parseDetails("🗓 2021-06-20").due).toBe("2021-06-20");
    expect(parseDetails("⏳️ 2024-11-18").scheduled).toBe("2024-11-18");
  });

  it("statuses, list markers, indentation and quotes", () => {
    expect(parseTaskLine("* [x] done ✅ 2026-10-01")!.status).toBe("DONE");
    expect(parseTaskLine("1. [/] half")!.status).toBe("IN_PROGRESS");
    expect(parseTaskLine("  + [-] dropped ❌ 2026-10-02")!.status).toBe("CANCELLED");
    expect(parseTaskLine("> - [ ] in a callout")!.description).toBe("in a callout");
    expect(parseTaskLine("- [] not a task")).toBeNull();
    expect(parseTaskLine("plain [ ] text")).toBeNull();
  });

  it("Hebrew descriptions and tags", () => {
    const t = parseTaskLine("- [ ] לשלם ארנונה #בית 🔼 📅 2026-11-01")!;
    expect(t.description).toBe("לשלם ארנונה #בית");
    expect(t.tags).toEqual(["#בית"]);
    expect(t.priority).toBe("medium");
  });

  it("skips frontmatter and code blocks, tracks headings", () => {
    const note = "---\ntitle: x\n- [ ] not in frontmatter\n---\n# Week\n- [ ] one\n```md\n- [ ] in code\n```\n## Later\n- [x] two";
    const ts = tasksInNote("n.md", note);
    expect(ts.map((t) => [t.description, t.heading, t.line])).toEqual([["one", "Week", 5], ["two", "Later", 10]]);
  });

  it("serialises back and toggles done with today's date", () => {
    const line = "- [ ] Pay rent #home ⏫ 🔁 every month 📅 2026-10-25 🆔 rent1";
    const t = parseTaskLine(line)!;
    expect(serializeTask(t)).toBe(line);
    const done = toggleTask(t, "2026-10-24");
    expect(serializeTask(done)).toBe("- [x] Pay rent #home ⏫ 🔁 every month 📅 2026-10-25 ✅ 2026-10-24 🆔 rent1");
    expect(serializeTask(toggleTask(done, "x"))).toBe(line);
  });
});

/**
 * Syntax compatibility on 20 files: notes from the obsidian-tasks
 * repository's test data (MIT), copied to eval/tasks-compat/. The expected
 * tasks (line and status character) are Obsidian's own Markdown cache for
 * each note, so the oracle is Obsidian, not this parser.
 */
describe("compatibility with obsidian-tasks notes (4.13 acceptance: 20 files)", () => {
  const dir = join(__dirname, "..", "..", "eval", "tasks-compat");
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Record<string, Array<Partial<Task>>>;
  const files = readdirSync(join(dir, "notes")).filter((f) => f.endsWith(".md"));

  it("has 20 files", () => expect(files.length).toBe(20));

  for (const f of files) {
    it(f, () => {
      const got = tasksInNote(f, readFileSync(join(dir, "notes", f), "utf8"));
      const want = expected[f];
      expect(got.length, "task count").toBe(want.length);
      want.forEach((w, i) => expect(got[i]).toMatchObject(w));
    });
  }
});

describe("queries (```tasks``` blocks)", () => {
  const all = tasksInNote(
    "Projects/Home.md",
    [
      "# Bills",
      "- [ ] rent ⏫ 📅 2026-10-24",
      "- [ ] water 📅 2026-10-30",
      "- [x] gas ✅ 2026-10-20 📅 2026-10-19",
      "# Ideas",
      "- [ ] paint #someday 🔽",
      "- [ ] fix door ⏳ 2026-10-23 🆔 door",
      "- [ ] buy hinge ⛔ door",
    ].join("\n"),
  );

  it("filters, sorts and limits like upstream", () => {
    const r = runQuery(parseQuery("not done\ndue before in 7 days\nsort by due", today), all, today);
    expect(r.groups[0].tasks.map((t) => t.description)).toEqual(["rent", "water"]);
    expect(runQuery(parseQuery("done", today), all, today).total).toBe(1);
    expect(runQuery(parseQuery("due today", today), all, today).groups[0].tasks[0].description).toBe("rent");
    expect(runQuery(parseQuery("priority is above none", today), all, today).total).toBe(1);
    expect(runQuery(parseQuery("tags include someday", today), all, today).total).toBe(1);
    expect(runQuery(parseQuery("is blocked", today), all, today).groups[0].tasks.map((t) => t.description)).toEqual(["buy hinge"]);
    expect(runQuery(parseQuery("(due on 2026-10-30) OR (has scheduled date)", today), all, today).total).toBe(2);
    expect(runQuery(parseQuery("not done\nlimit 2", today), all, today).groups[0].tasks).toHaveLength(2);
    expect(runQuery(parseQuery("path includes projects/home\nheading includes ideas", today), all, today).total).toBe(3);
  });

  it("groups by heading", () => {
    const r = runQuery(parseQuery("group by heading", today), all, today);
    expect(r.groups.map((g) => [g.name, g.tasks.length])).toEqual([["Bills", 3], ["Ideas", 3]]);
  });

  it("names empty and status groups by label (translated in the block), and puts them last", () => {
    const r = runQuery(parseQuery("group by due", today), all, today);
    expect(r.groups.map((g) => g.label ?? g.name)).toEqual(["2026-10-19", "2026-10-24", "2026-10-30", "none"]);
    expect(runQuery(parseQuery("group by status", today), all, today).groups.map((g) => [g.label, g.tasks.length])).toEqual([["todo", 5], ["done", 1]]);
    expect(runQuery(parseQuery("group by priority", today), all, today).groups.map((g) => g.label ?? g.name)).toEqual(["⏫", "none", "🔽"]);
  });

  it("reports what it doesn't understand instead of ignoring it", () => {
    expect(runQuery(parseQuery("due whenever", today), all, today).errors).toEqual([{ code: "date", text: "whenever" }]);
    expect(runQuery(parseQuery("description regex matches /(/", today), all, today).errors).toEqual([{ code: "regex", text: "/(/" }]);
    expect(runQuery(parseQuery("frobnicate", today), all, today).errors).toEqual([{ code: "query", text: "frobnicate" }]);
  });

  it("relative dates", () => {
    expect(parseDate("tomorrow", today)).toBe("2026-10-25");
    expect(parseDate("in 2 weeks", today)).toBe("2026-11-07");
    expect(parseDate("3 days ago", today)).toBe("2026-10-21");
  });

  it("1,000 tasks: a query under 100 ms (4.13 acceptance)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const d = `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
      lines.push(`- [${i % 5 === 0 ? "x" : " "}] task ${i} #t${i % 7} ${["⏫", "🔼", "", "🔽"][i % 4]} 📅 ${d}`);
    }
    const many = tasksInNote("big.md", lines.join("\n"));
    expect(many).toHaveLength(1000);
    const q = parseQuery("not done\ndue after 2026-03-01\ntags include t3\nsort by priority\ngroup by due", today);
    runQuery(q, many, today); // warm-up
    const t0 = performance.now();
    const r = runQuery(q, many, today);
    const ms = performance.now() - t0;
    expect(r.total).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100);
  });
});

describe("index worker: tasks over the vault (4.13.2)", () => {
  it("answers ```tasks``` queries through the protocol and re-parses only changed notes", async () => {
    const { VaultIndex } = await import("../storage/vaultIndexCore");
    const { handleIndexRequest } = await import("../storage/vaultIndexLocal");
    const index = new VaultIndex();
    handleIndexRequest(index, { id: 1, op: "upsert", files: [
      { path: "a.md", name: "a.md", content: "- [ ] alpha 📅 2026-10-24", modified: 1 },
      { path: "b.md", name: "b.md", content: "no tasks here", modified: 1 },
    ] });
    let r = handleIndexRequest(index, { id: 2, op: "tasks", query: "due today", today: "2026-10-24" });
    expect(r.ok && (r.result as { total: number }).total).toBe(1);
    handleIndexRequest(index, { id: 3, op: "upsert", files: [{ path: "b.md", name: "b.md", content: "- [ ] beta 📅 2026-10-24", modified: 2 }] });
    r = handleIndexRequest(index, { id: 4, op: "tasks", query: "due today\nsort by description", today: "2026-10-24" });
    expect(r.ok && (r.result as { groups: Array<{ tasks: Array<{ description: string }> }> }).groups[0].tasks.map((t) => t.description)).toEqual(["alpha", "beta"]);
    handleIndexRequest(index, { id: 5, op: "remove", paths: ["a.md"] });
    r = handleIndexRequest(index, { id: 6, op: "tasks", query: "not done", today: "2026-10-24" });
    expect(r.ok && (r.result as { total: number }).total).toBe(1);
  });

  it("reads tasks from Markdown notes only, not from a PDF or other file in the index", async () => {
    const { VaultIndex } = await import("../storage/vaultIndexCore");
    const index = new VaultIndex();
    index.upsert({ path: "paper.pdf", name: "paper.pdf", content: "%PDF-1.7\n- [ ] not a task\n", modified: 1 });
    index.upsert({ path: "list.txt", name: "list.txt", content: "- [ ] not a task either", modified: 1 });
    index.upsert({ path: "Note.MD", name: "Note.MD", content: "- [ ] a task", modified: 1 });
    expect(index.allTasks().map((t) => t.path)).toEqual(["Note.MD"]);
  });
});

describe("toggling in the note", () => {
  it("rewrites the one line, keeps indentation, CRLF and the list marker", async () => {
    const { toggledContent } = await import("../tasks/toggle");
    const note = "# x\r\n  * [ ] one 📅 2026-10-25\r\n- [ ] two\r\n";
    const [task] = tasksInNote("n.md", note);
    expect(toggledContent(note, task, "2026-10-24")).toBe("# x\r\n  * [x] one 📅 2026-10-25 ✅ 2026-10-24\r\n- [ ] two\r\n");
  });

  it("changes only the checkbox and the done date; the rest of the line is kept as written", async () => {
    const { toggledContent } = await import("../tasks/toggle");
    const toggle = (line: string) => toggledContent(line, tasksInNote("n.md", line)[0], "2026-10-24");
    // Field order, the alternative due emoji and double spaces are not normalised.
    expect(toggle("- [ ] one 📆 2026-10-25  ⏫")).toBe("- [x] one 📆 2026-10-25  ⏫ ✅ 2026-10-24");
    // The done date goes before a block link, which stays last.
    expect(toggle("- [ ] two 📅 2026-10-25 ^blk-1")).toBe("- [x] two 📅 2026-10-25 ✅ 2026-10-24 ^blk-1");
    // Back to todo removes the done date and nothing else.
    expect(toggle("> 1. [x] three ✅ 2026-10-20 📅 2026-10-19")).toBe("> 1. [ ] three 📅 2026-10-19");
    // A cancelled task unticks to todo.
    expect(toggle("- [-] four ❌ 2026-10-02")).toBe("- [ ] four ❌ 2026-10-02");
    // A list item whose first child is the task keeps both markers.
    expect(toggle("1. 1. [ ] five")).toBe("1. 1. [x] five ✅ 2026-10-24");
    // A done task without a date unticks cleanly.
    expect(toggle("- [x] six")).toBe("- [ ] six");
  });

  it("writes nothing when the note changed meanwhile", async () => {
    const { toggledContent } = await import("../tasks/toggle");
    const [task] = tasksInNote("n.md", "- [ ] one");
    expect(toggledContent("- [ ] something else", task)).toBeNull();
    expect(toggledContent("", { ...task, line: 5 })).toBeNull();
  });
});

describe("reminders (4.13.4)", () => {
  it("announce each task due today once per day, and need permission", async () => {
    const { checkReminders, setRemindersEnabled, remindersEnabled } = await import("../tasks/reminders");
    localStorage.clear();
    const denied = { permission: "default", requestPermission: async () => "denied" } as unknown as typeof Notification;
    expect(await setRemindersEnabled(true, denied)).toBe(false);
    expect(remindersEnabled()).toBe(false);
    const tasks = tasksInNote("Home.md", "- [ ] rent 📅 2026-10-24\n- [ ] later 📅 2026-10-30\n- [x] paid 📅 2026-10-24\n- [ ] call ⏳ 2026-10-24");
    const sent: string[] = [];
    const deps = { today: "2026-10-24", tasks: async () => tasks, notify: (_t: string, b: string) => sent.push(b) };
    expect(await checkReminders(deps)).toBe(2);
    expect(sent).toEqual(["rent — Home", "call — Home"]);
    expect(await checkReminders(deps)).toBe(0);
    expect(await checkReminders({ ...deps, today: "2026-10-25", tasks: async () => tasksInNote("Home.md", "- [ ] rent 📅 2026-10-25") })).toBe(1);
  });
});
