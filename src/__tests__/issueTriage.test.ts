// @vitest-environment node
/**
 * Plan 14.3 — the issue-triage agent: labels, duplicates, reproduction
 * requests, plan links, the daily report, and the workflow that runs it on
 * every new issue and every day (so a new issue is triaged within 24 h).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import {
  classify,
  areas,
  duplicateOf,
  needsRepro,
  planTask,
  triage,
  commentFor,
  report,
  runTriage,
  MARKER,
  TRIAGED,
  LABELS,
  DAY_MS,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/issue-triage.mjs";

const ROOT = resolve(__dirname, "..", "..");
type Issue = { number: number; title: string; body?: string; state: "open" | "closed"; created_at: string; labels?: { name: string }[] };
const now = Date.parse("2026-10-24T12:00:00Z");
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const issue = (n: number, title: string, body = "", extra: Partial<Issue> = {}): Issue => ({ number: n, title, body, state: "open", created_at: at(1), labels: [], ...extra });
const tasks = [
  { id: "4.5", title: "השלמת קישורים [[ — פתקים, כותרות, בלוקים", status: "✅ #217" },
  { id: "9.2", title: "בודק איות עברי", status: undefined },
  { id: "6.1", title: "Transcription: local Whisper in a worker", status: "⏳ #183" },
];

describe("classification", () => {
  it("bug, enhancement, question, documentation — in English and Hebrew", () => {
    expect(classify(issue(1, "Editor crashes when pasting a table"))).toBe("bug");
    expect(classify(issue(2, "העורך קורס בהדבקה"))).toBe("bug");
    expect(classify(issue(3, "Feature request: export to EPUB"))).toBe("enhancement");
    expect(classify(issue(4, "בקשה: ייצוא ל-EPUB"))).toBe("enhancement");
    expect(classify(issue(5, "How do I change the font?"))).toBe("question");
    expect(classify(issue(6, "Typo in the docs", "The README says 'teh'"))).toBe("documentation");
    expect(classify(issue(7, "Hello"))).toBeNull();
  });

  it("area labels from the words used, at most two", () => {
    expect(areas(issue(1, "Hebrew text renders LTR in the preview", "RTL is wrong in the preview table")).sort()).toEqual(["area:hebrew", "area:render"]);
    expect(areas(issue(2, "Ollama model not found", "the agent fails to load the model")).length).toBeLessThanOrEqual(2);
    expect(areas(issue(2, "Ollama model not found", "the agent fails to load the model"))[0]).toBe("area:ai");
    expect(areas(issue(3, "Hello"))).toEqual([]);
  });
});

describe("duplicates, reproduction, plan link", () => {
  it("finds a near-identical title, open or closed, and not an unrelated one", () => {
    const others = [issue(10, "Crash when pasting a large table", "", { state: "closed" }), issue(11, "Dark mode colors", "")];
    expect(duplicateOf(issue(12, "Crash when pasting large tables"), others)?.number).toBe(10);
    expect(duplicateOf(issue(13, "Export to EPUB"), others)).toBeNull();
    expect(duplicateOf(issue(10, "Crash when pasting a large table"), others)).toBeNull(); // never itself
  });

  it("asks a bug for reproduction only when it has none", () => {
    expect(needsRepro(issue(1, "It crashes", "it just crashes"), "bug")).toBe(true);
    expect(needsRepro(issue(2, "It crashes", "Steps to reproduce:\n1. open\n2. paste\nChrome 124"), "bug")).toBe(false);
    expect(needsRepro(issue(3, "Add EPUB export", "please"), "enhancement")).toBe(false);
  });

  it("links the plan task by number, else by title words", () => {
    expect(planTask(issue(1, "Something", "This is about task 9.2 I think"), tasks)?.id).toBe("9.2");
    expect(planTask(issue(2, "השלמת קישורים [[ לא מציעה כותרות"), tasks)?.id).toBe("4.5");
    expect(planTask(issue(3, "Dark mode colors"), tasks)).toBeNull();
  });

  it("puts it all into one triage result and one bilingual comment, once", () => {
    const r = triage(issue(20, "Crash when pasting large tables", "it crashes, see 9.2"), { others: [issue(10, "Crash when pasting a large table", "", { state: "closed" })], tasks });
    expect(r.kind).toBe("bug");
    expect(r.labels).toEqual(expect.arrayContaining(["bug", "duplicate?", "needs-repro", TRIAGED]));
    expect(r.dup?.number).toBe(10);
    expect(r.task?.id).toBe("9.2");
    const c = commentFor(r)!;
    expect(c.startsWith(MARKER)).toBe(true);
    expect(c).toContain("#10");
    expect(c).toContain("steps (1, 2, 3…)");
    expect(c).toContain("השלבים (1, 2, 3…)");
    expect(c).toContain("**9.2 · בודק איות עברי**");
    // Nothing to say: no comment (labels only).
    expect(commentFor(triage(issue(21, "Add EPUB export", "Steps: n/a"), { tasks: [] }))).toBeNull();
    // Labels the issue already has are not added again.
    expect(triage(issue(22, "Crash", "1. open 2. crash. Chrome", { labels: [{ name: "bug" }] }), {}).labels).not.toContain("bug");
  });
});

describe("the run and the daily report", () => {
  function fakeApi(issues: Issue[]) {
    const writes: string[] = [];
    const comments = new Map<number, { body: string }[]>();
    return {
      writes,
      api: {
        issues: () => issues,
        comments: (n: number) => comments.get(n) ?? [],
        labels: () => ["bug", "question"],
        createLabel: (name: string) => writes.push(`label ${name}`),
        addLabels: (n: number, labels: string[]) => writes.push(`#${n} += ${labels.join(",")}`),
        comment: (n: number, body: string) => {
          writes.push(`#${n} comment`);
          comments.set(n, [...(comments.get(n) ?? []), { body }]);
        },
      },
    };
  }

  it("a dry run writes nothing; --apply creates the missing labels, labels and comments once", () => {
    const issues = [issue(1, "Crash when pasting a table", "it crashes"), issue(2, "Old untriaged", "", { created_at: at(30) }), issue(3, "Done already", "", { labels: [{ name: TRIAGED }] })];
    const dry = fakeApi(issues);
    const r1 = runTriage(dry.api, { apply: false, tasks, now, log: () => {} });
    expect(dry.writes).toEqual([]);
    expect(r1.results.map((r: { number: number }) => r.number)).toEqual([1, 2]);
    const wet = fakeApi(issues);
    runTriage(wet.api, { apply: true, tasks, now, log: () => {} });
    const created = wet.writes.filter((w) => w.startsWith("label ")).map((w) => w.slice(6));
    expect(created).toEqual(Object.keys(LABELS).filter((l) => !["bug", "question"].includes(l)));
    expect(wet.writes).toContain("#1 comment");
    expect(wet.writes.some((w) => w.startsWith("#1 += ") && w.includes("needs-repro") && w.includes(TRIAGED))).toBe(true);
    // A second run does not comment again on #1.
    const before = wet.writes.length;
    runTriage(wet.api, { apply: true, tasks, now, log: () => {} });
    expect(wet.writes.slice(before).filter((w) => w.endsWith("comment"))).toEqual([]);
  });

  it("the report lists the last day's issues and flags open issues older than 24 h without triage", () => {
    const issues = [issue(1, "New one", "", { created_at: at(2) }), issue(2, "Old untriaged", "", { created_at: at(30) }), issue(3, "Old triaged", "", { created_at: at(30), labels: [{ name: TRIAGED }] }), issue(4, "Old closed", "", { created_at: at(50), state: "closed" })];
    const rep = report(issues, [], now);
    expect(rep.recent).toBe(1);
    expect(rep.late).toEqual([2]);
    expect(rep.markdown).toContain("| #1 | New one |");
    expect(rep.markdown).toContain("- #2 Old untriaged");
    expect(rep.markdown).not.toContain("#3 Old triaged");
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe("issue-triage.yml", () => {
  const wf = YAML.parse(readFileSync(join(ROOT, ".github/workflows/issue-triage.yml"), "utf8"));
  it("runs when an issue is opened and every day, may write issues, and uploads the report", () => {
    expect(wf.on.issues.types).toEqual(["opened", "reopened"]);
    expect(wf.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.jobs.triage.permissions.issues).toBe("write");
    expect(wf.jobs.triage["runs-on"]).toBe("ubuntu-24.04");
    const run = wf.jobs.triage.steps.find((s: { run?: string }) => s.run)!.run as string;
    expect(run).toContain("scripts/issue-triage.mjs --apply");
    for (const line of readFileSync(join(ROOT, ".github/workflows/issue-triage.yml"), "utf8").split("\n").filter((l) => /uses:/.test(l))) {
      expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d/);
    }
  });
});

describe("docs", () => {
  it("has an English and a Hebrew page, both in the sidebar", () => {
    for (const p of ["docs/src/content/docs/project/issue-triage.md", "docs/src/content/docs/he/project/issue-triage.md"]) {
      const md = readFileSync(join(ROOT, p), "utf8");
      expect(md).toMatch(/^---\ntitle: .+\ndescription: .+\n---/);
      for (const label of ["needs-repro", "duplicate?", TRIAGED, "--apply"]) expect(md).toContain(label);
    }
    expect(readFileSync(join(ROOT, "docs/astro.config.mjs"), "utf8")).toContain('slug: "project/issue-triage"');
  });
});
