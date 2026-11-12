/**
 * GitHub Discussions (plan W4.34): the category forms are well formed and
 * each names one of the categories docs/dev/github-discussions.md sets up.
 * (Their match with the live categories is `node scripts/discussions-check.mjs`, which needs gh.)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs modules without types
import { CATEGORIES, formProblems } from "../../scripts/discussions-check.mjs";

const DIR = resolve(__dirname, "../../.github/DISCUSSION_TEMPLATE");

describe("discussion category forms", () => {
  const forms = readdirSync(DIR).sort();

  it("there is a form for Q&A, Ideas and Show and tell, with Hebrew labels", () => {
    expect(forms).toEqual(["ideas.yml", "q-a.yml", "show-and-tell.yml"]);
    for (const f of forms) expect(readFileSync(join(DIR, f), "utf8")).toMatch(/label: [\u0590-\u05FF]/);
  });

  it("each passes the check", () => {
    for (const f of forms) expect(formProblems(f, readFileSync(join(DIR, f), "utf8")), f).toEqual([]);
  });

  it("the check catches a form without fields, a poll form, and a form for an unknown category", () => {
    expect(formProblems("q-a.yml", '# Category "Q&A · שאלות ותשובות"\nbody:\n  - type: markdown\n')).toHaveLength(1);
    expect(formProblems("polls.yml", `# Category "${CATEGORIES.polls}"\nbody:\n  - type: textarea\n    id: a\n`)).toEqual(["polls.yml: GitHub does not support forms for poll categories"]);
    expect(formProblems("x.yml", '# Category "Random"\nbody:\n  - type: input\n    id: a\n')).toHaveLength(1);
  });
});
