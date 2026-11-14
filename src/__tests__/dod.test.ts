// @vitest-environment node
/**
 * Plan 0.7 — the definition-of-done checker (scripts/dod.mjs) and the rule
 * plan:check enforces with it: no ✅ without the commands that prove it.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkDod,
  select,
  runDod,
  markdown,
  allTasks,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/dod.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { run } from "../../scripts/plan/build.mjs";

type Task = { id: string; title?: string; status?: string; dod?: string[]; dodMock?: boolean; acceptance?: string[] };
type Plan = { dodGrandfathered?: string[]; dodRevoked?: string[]; phases: { tasks: Task[] }[] };

const ROOT = resolve(__dirname, "..", "..");
const plan = (): Plan => JSON.parse(readFileSync(join(ROOT, "plan/plan.json"), "utf8"));
const task = (p: Plan, id: string): Task => allTasks(p).find((t: Task) => t.id === id);
const tmp = mkdtempSync(join(tmpdir(), "lumen-dod-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const mini = (tasks: Task[]): Plan => ({ phases: [{ tasks }] });
const check = (p: Plan) => checkDod(p);

describe("checkDod", () => {
  it("the checked-in plan follows the rule", () => {
    expect(checkDod(plan())).toEqual([]);
  });

  it("refuses a ✅ without a dod", () => {
    const problems = check(mini([{ id: "1.1", status: "✅ #1" }]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/1\.1 is marked ✅ without a dod/);
  });

  it("refuses a ✅* without a dod too", () => {
    expect(check(mini([{ id: "1.1", status: "✅* #1" }]))[0]).toMatch(/without a dod/);
  });

  it("accepts a ✅ with commands, and open tasks without", () => {
    expect(check(mini([{ id: "1.1", status: "✅ #1", dod: ["true"] }, { id: "1.2" }, { id: "1.3", status: "⏳ #2" }]))).toEqual([]);
  });

  it("a mock-only task is ✅*, never plain ✅", () => {
    expect(check(mini([{ id: "1.1", status: "✅ #1", dod: ["true"], dodMock: true }]))[0]).toMatch(/mark it ✅\*/);
    expect(check(mini([{ id: "1.1", status: "✅* #1", dod: ["true"], dodMock: true }]))).toEqual([]);
  });

  it("no task is exempt: a grandfather list is refused, whatever it holds (W10.G5)", () => {
    // the 0.7 exemption is gone: listing a done task no longer lets it pass without a dod
    const listed = checkDod({ dodGrandfathered: ["1.1"], phases: [{ tasks: [{ id: "1.1", status: "✅ #1" }] }] });
    expect(listed.some((m: string) => /dodGrandfathered: no task is exempt/.test(m))).toBe(true);
    expect(listed.some((m: string) => /1\.1 is marked ✅ without a dod/.test(m))).toBe(true);
    // an empty list or a revocation record is refused too: the mechanism is deleted, not emptied
    expect(checkDod({ dodGrandfathered: [], phases: [{ tasks: [] }] })[0]).toMatch(/dodGrandfathered: no task is exempt/);
    expect(checkDod({ dodRevoked: ["1.1"], phases: [{ tasks: [] }] })[0]).toMatch(/dodRevoked: no task is exempt/);
  });

  it("the checked-in plan exempts nothing, and every ✅ in it has its commands (W10.G1–G5)", () => {
    const p = plan();
    expect(p.dodGrandfathered).toBeUndefined();
    expect(p.dodRevoked).toBeUndefined();
    const done = allTasks(p).filter((t: Task) => (t.status ?? "").startsWith("✅"));
    expect(done.length).toBeGreaterThan(0);
    for (const t of done) expect(t.dod?.length, t.id).toBeGreaterThan(0);
  });

  it("a reopened task can't return to ✅ without a dod", () => {
    expect(check(mini([{ id: "1.1", status: "⏳ again" }]))).toEqual([]);
    expect(check(mini([{ id: "1.1", status: "✅ #2" }]))[0]).toMatch(/without a dod/);
  });

  it("a ✅* task declares dodMock, so it can't quietly become ✅ (Codex P1, #265)", () => {
    expect(check(mini([{ id: "1.1", status: "✅* #1", dod: ["true"] }]))[0]).toMatch(/✅\* without "dodMock": true/);
    expect(check(mini([{ id: "1.1", status: "✅* #1", dod: ["true"], dodMock: true }]))).toEqual([]);
  });

  it("a dod is a list of non-empty commands", () => {
    expect(check(mini([{ id: "1.1", status: "✅ #1", dod: [" "] }]))[0]).toMatch(/list of commands/);
  });
});

describe("plan:check", () => {
  it("fails when a done task loses its dod", () => {
    const dir = join(tmp, "nodod");
    mkdirSync(join(dir, "plan"), { recursive: true });
    for (const f of ["plan/plan.json", "plan/board.html", "MASTER_PLAN.md"]) cpSync(join(ROOT, f), join(dir, f));
    const p = plan();
    delete task(p, "0.6").dod;
    writeFileSync(join(dir, "plan/plan.json"), JSON.stringify(p, null, 1) + "\n");
    expect(() => run({ root: dir, check: true })).toThrow(/0\.6 is marked ✅ without a dod/);
  });
});

describe("runDod", () => {
  it("runs each command, stops a task at its first failure, and reports it", () => {
    const ran: string[] = [];
    const exec = (cmd: string) => {
      ran.push(cmd);
      return cmd !== "bad";
    };
    const results = runDod(
      [
        { id: "a", dod: ["one", "bad", "never"] },
        { id: "b", dod: ["two"] },
        { id: "c" },
      ],
      { exec, log: () => {} },
    );
    expect(ran).toEqual(["one", "bad", "two"]);
    expect(results.map((r: { id: string; ok: boolean; failed?: string }) => [r.id, r.ok, r.failed])).toEqual([
      ["a", false, "bad"],
      ["b", true, undefined],
      ["c", false, undefined],
    ]);
  });
});

describe("select and markdown", () => {
  it("--done picks every done task that has a dod", () => {
    const ids = select(plan(), { done: true }).map((t: Task) => t.id);
    expect(ids).toContain("0.6");
    for (const id of ids) expect(task(plan(), id).status).toMatch(/^✅/);
  });

  it("an unknown id is an error", () => {
    expect(() => select(plan(), { ids: ["99.9"] })).toThrow(/no task 99\.9/);
  });

  it("the PR checklist lists acceptance and commands", () => {
    const md = markdown([task(plan(), "0.6")]);
    expect(md).toMatch(/^### 0\.6 · /);
    expect(md).toContain("- [ ] `npm run plan:check` green");
  });
});
