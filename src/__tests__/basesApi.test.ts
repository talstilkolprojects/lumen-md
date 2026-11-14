/**
 * Plan W6.46 — a database at Notion's level: the local Bases API for
 * scripts and plugins (one approval per update, nothing written without it),
 * "when a row changes" automations, and 10,000 rows filtered and sorted.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { MAX_EDITS, queryBase, updateRows, validateEdits, type BasesApiDeps, type UpdateSummary } from "../views/bases/api";
import { basesFileFromText, compileFilter, parseBase, runBase } from "../views/bases/base";
import { parseBases } from "../views/bases/evaluate";
import { METHOD_CAPABILITY } from "../plugins/runtime/capabilities";
import { parseManifest } from "../plugins/runtime/manifest";
import { fires, isRowOf, plan, type Rule } from "../automations/engine";

const baseOf = (src: string) => {
  const p = parseBase(src);
  if (!p.ok) throw new Error(p.error);
  return p.base;
};

/** An in-memory vault with a write log and a scripted approval screen. */
function vault(files: Record<string, string>, answer = true) {
  const fs = new Map(Object.entries(files));
  const writes: string[] = [];
  const asked: UpdateSummary[] = [];
  const deps: BasesApiDeps = {
    paths: async () => [...fs.keys()],
    readText: async (p) => {
      const t = fs.get(p);
      if (t === undefined) throw new Error(`no ${p}`);
      return t;
    },
    write: async (p, t) => {
      writes.push(p);
      fs.set(p, t);
    },
    confirm: async (s) => {
      asked.push(s);
      return answer;
    },
    now: new Date("2026-11-12T12:00:00Z"),
  };
  return { fs, writes, asked, deps };
}

const TASKS_BASE = `filters: file.inFolder("Tasks")
views:
  - type: table
    name: Open
    filters: 'status != "done"'
    order: [file.name, status, priority]
    sort:
      - property: priority
        direction: DESC
`;
const task = (status: string, priority: number) => `---\nstatus: ${status}\npriority: ${priority}\n---\n# Task\n`;

describe("the Bases API: query", () => {
  it("returns a view's rows, columns and total as JSON, paged", async () => {
    const v = vault({ "Tasks.base": TASKS_BASE, "Tasks/a.md": task("todo", 1), "Tasks/b.md": task("done", 3), "Tasks/c.md": task("doing", 2), "Notes/x.md": task("todo", 9) });
    const r = await queryBase(v.deps, "Tasks.base");
    expect(r.view).toBe("Open");
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => x.path)).toEqual(["Tasks/c.md", "Tasks/a.md"]);
    expect(r.rows[0].cells).toEqual({ "file.name": "c.md", "note.status": "doing", "note.priority": 2 });
    expect((await queryBase(v.deps, "Tasks.base", "Open", { offset: 1, limit: 1 })).rows.map((x) => x.path)).toEqual(["Tasks/a.md"]);
    await expect(queryBase(v.deps, "../secret.base")).rejects.toThrow(/\.base file in the vault/);
    expect(v.writes).toEqual([]);
  });
});

describe("the Bases API: update — one approval, and nothing without it", () => {
  it("1,000 rows through ONE approval screen, in well under 5 s", async () => {
    const files: Record<string, string> = { "Tasks.base": TASKS_BASE };
    for (let i = 0; i < 1000; i++) files[`Tasks/t${i}.md`] = task("todo", i % 5);
    const v = vault(files);
    const edits = Array.from({ length: 1000 }, (_, i) => ({ path: `Tasks/t${i}.md`, set: { status: "doing", "note.reviewed": true } }));
    const t0 = performance.now();
    const r = await updateRows(v.deps, edits);
    const ms = performance.now() - t0;
    expect(r).toEqual({ written: 1000, unchanged: 0, declined: false });
    expect(v.asked).toHaveLength(1);
    expect(v.asked[0]).toMatchObject({ notes: 1000, properties: ["reviewed", "status"], sample: ["Tasks/t0.md", "Tasks/t1.md", "Tasks/t2.md", "Tasks/t3.md", "Tasks/t4.md"] });
    expect(v.writes).toHaveLength(1000);
    expect(v.fs.get("Tasks/t7.md")).toBe("---\nstatus: doing\npriority: 2\nreviewed: true\n---\n# Task\n");
    expect(ms).toBeLessThan(5000);
    console.log(`bases.update: 1,000 rows, 1 approval, ${ms.toFixed(0)} ms`);
  });

  it("declined: 0 writes", async () => {
    const v = vault({ "Tasks/a.md": task("todo", 1), "Tasks/b.md": task("todo", 2) }, false);
    const r = await updateRows(v.deps, [
      { path: "Tasks/a.md", set: { status: "done" } },
      { path: "Tasks/b.md", set: { status: "done" } },
    ]);
    expect(r).toEqual({ written: 0, unchanged: 0, declined: true });
    expect(v.asked).toHaveLength(1);
    expect(v.writes).toEqual([]);
    expect(v.fs.get("Tasks/a.md")).toBe(task("todo", 1));
  });

  it("bad edits are refused before the approval screen, and before any write", async () => {
    const v = vault({ "Tasks/a.md": task("todo", 1) });
    for (const bad of [
      "x",
      [{ path: "../etc/passwd.md", set: { a: 1 } }],
      [{ path: ".lumen/automations.json", set: { a: 1 } }],
      [{ path: "Tasks/a.md", set: {} }],
      [{ path: "Tasks/a.md", set: { "bad:name": 1 } }],
      [{ path: "Tasks/a.md", set: { a: { nested: true } } }],
      Array.from({ length: MAX_EDITS + 1 }, () => ({ path: "Tasks/a.md", set: { a: 1 } })),
    ]) {
      await expect(updateRows(v.deps, bad), JSON.stringify(bad).slice(0, 60)).rejects.toThrow();
    }
    expect(v.asked).toEqual([]);
    expect(v.writes).toEqual([]);
  });

  it("an edit that changes nothing asks nothing and writes nothing", async () => {
    const v = vault({ "Tasks/a.md": task("todo", 1) });
    expect(await updateRows(v.deps, [{ path: "Tasks/a.md", set: { status: "todo" } }])).toEqual({ written: 0, unchanged: 1, declined: false });
    expect(v.asked).toEqual([]);
    expect(v.writes).toEqual([]);
  });

  it("validateEdits keeps `note.` off the property name", () => {
    expect(validateEdits([{ path: "a.md", set: { "note.status": "x", tags: ["a", "b"] } }])).toEqual([{ path: "a.md", set: { status: "x", tags: ["a", "b"] } }]);
  });

  it("is a plugin capability of its own, declared and granted like the rest (#367)", () => {
    expect(METHOD_CAPABILITY["bases.query"]).toBe("bases:read");
    expect(METHOD_CAPABILITY["bases.update"]).toBe("bases:write");
    const m = parseManifest({ schema: 1, id: "bulk-status", name: "Bulk status", version: "1.0.0", description: "Sets the status of many tasks", author: "Lumen", license: "MIT", main: "main.js", capabilities: [{ id: "bases:write", reason: "Set the status of many tasks at once" }] });
    expect(m.capabilities.map((c) => c.id)).toEqual(["bases:write"]);
  });
});

describe("automations on a view: when a row changes", () => {
  const files: Record<string, string> = {
    "Tasks.base": TASKS_BASE,
    "Tasks/a.md": task("todo", 1),
    "Notes/x.md": task("todo", 1),
  };
  const ctx = { vault: { read: (p: string) => files[p] ?? null, exists: (p: string) => p in files }, dailyPath: (d: string) => `Daily/${d}.md`, today: "2026-11-12" };
  const rule = (property?: string): Rule => ({ id: "r", name: "row", enabled: true, when: { kind: "rowChanged", base: "Tasks.base", view: "Open", property }, then: [{ kind: "tag", tag: "touched" }] });

  it("fires for a row of the view whose properties change; not outside the view", () => {
    const changed = (path: string, before: string, after: string) => ({ kind: "changed" as const, path, before, after });
    expect(fires(rule(), changed("Tasks/a.md", task("todo", 1), task("doing", 1)), ctx)).toBe(true);
    // The body changed, not a property.
    expect(fires(rule(), changed("Tasks/a.md", task("todo", 1), task("todo", 1) + "more\n"), ctx)).toBe(false);
    // Outside the base's folder, or out of the view (done is filtered out).
    expect(fires(rule(), changed("Notes/x.md", task("todo", 1), task("doing", 1)), ctx)).toBe(false);
    expect(fires(rule(), changed("Tasks/a.md", task("todo", 1), task("done", 1)), ctx)).toBe(false);
    // A watched property: only that one.
    expect(fires(rule("priority"), changed("Tasks/a.md", task("todo", 1), task("doing", 1)), ctx)).toBe(false);
    expect(fires(rule("priority"), changed("Tasks/a.md", task("todo", 1), task("todo", 3)), ctx)).toBe(true);
    // A new note that joins the view.
    expect(fires(rule(), { kind: "created", path: "Tasks/new.md", text: task("todo", 2) }, ctx)).toBe(true);
    expect(fires(rule(), { kind: "created", path: "Tasks/new.md", text: task("todo", 2), moved: true }, ctx)).toBe(false);
    // A missing base or view has no rows.
    expect(fires({ ...rule(), when: { kind: "rowChanged", base: "Nope.base" } }, changed("Tasks/a.md", task("todo", 1), task("doing", 1)), ctx)).toBe(false);
    expect(isRowOf(TASKS_BASE, "No such view", "Tasks/a.md", task("todo", 1))).toBe(false);
  });

  it("runs its actions through the plan, with the loop guard (its own tag write is a change, but not again)", () => {
    const p = plan([rule()], { kind: "changed", path: "Tasks/a.md", before: task("todo", 1), after: task("doing", 1) }, ctx);
    expect(p.fired.map((f) => f.rule)).toEqual(["r"]);
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ kind: "write", path: "Tasks/a.md" });
    expect(p.stopped).toEqual([{ rule: "r", on: "Tasks/a.md", reason: "repeat" }]);
  });
});

describe("10,000 rows: filter and sort", () => {
  const N = 10_000;
  const statuses = ["todo", "doing", "done", "blocked"];
  const files = Array.from({ length: N }, (_, i) =>
    basesFileFromText(`tasks/t${i}.md`, `---\ntitle: משימה ${i}\nstatus: ${statuses[i % 4]}\npriority: ${(i * 7919) % 5}\ndue: 2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}\nestimate: ${(i * 31) % 40}\n---\n`),
  );
  const src = `filters:\n  and:\n    - file.inFolder("tasks")\n    - 'status != "done"'\nformulas:\n  load: estimate * priority\nviews:\n  - type: table\n    name: Open\n    filters: 'priority >= 2'\n    order: [file.name, status, priority, due, formula.load]\n    sort:\n      - property: priority\n        direction: DESC\n      - property: due\n        direction: ASC\n`;

  it("the right rows in the right order, and fast (median of 9 runs; the measured numbers are in the PR)", () => {
    const p = parseBase(src);
    if (!p.ok) throw new Error(p.error);
    const times: number[] = [];
    let r = runBase(p.base, files);
    for (let k = 0; k < 9; k++) {
      const t0 = performance.now();
      r = runBase(p.base, files);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(r.errors).toEqual([]);
    expect(r.total).toBe(4500);
    const pr = r.rows.map((x) => Number(x.cells["note.priority"]));
    expect(pr.every((x, i) => i === 0 || pr[i - 1] >= x)).toBe(true);
    expect(r.rows.every((x) => x.cells["note.status"] !== "done")).toBe(true);
    // A loose bound for shared machines; the target (100 ms) is measured in the harness.
    expect(times[4]).toBeLessThan(500);
    console.log(`runBase 10,000 rows: median ${times[4].toFixed(1)} ms`);
  });

  it("the fast filters give exactly what the interpreter gives", () => {
    const statements = ['status != "done"', "priority >= 2", "2 <= priority", 'file.inFolder("tasks")', 'file.hasTag("x") || status == "todo"', "!(estimate > 20)", 'note.status == "doing" && priority < 3', "missing == null"];
    for (const s of statements) {
      const tree = parseBases(s);
      if (!tree.ok) throw new Error(s);
      expect(compileFilter(tree.tree), s).not.toBeNull();
      const fast = runBase(baseOf(`views:\n  - type: table\n    name: V\n    filters: ${JSON.stringify(s)}\n`), files.slice(0, 400)).rows.map((x) => x.file.path);
      // The same statement wrapped so the compiler can't take it: the interpreter's answer.
      const slow = runBase(baseOf(`views:\n  - type: table\n    name: V\n    filters: ${JSON.stringify(`if(true, ${s}, false)`)}\n`), files.slice(0, 400)).rows.map((x) => x.file.path);
      expect(fast, s).toEqual(slow);
    }
  });
});
