/**
 * Plan 13.1 — docs-audit: a finished task that changed what a user sees,
 * and whose pull requests wrote no docs page, is reported unless
 * docs/required-pages.json names its page (scripts/docs-audit.mjs).
 */
import { describe, expect, it } from "vitest";
import {
  audit,
  formatFinding,
  isDocsPage,
  isFinished,
  isUiFile,
  planTasks,
  taskIds,
  // @ts-expect-error — plain .mjs script without types
} from "../../scripts/docs-audit.mjs";

const known = new Set(["0.9", "4.5", "4.6", "6.1", "13.1", "13.1.1", "W8.9", "W8.10"]);

describe("docs-audit (plan 13.1)", () => {
  it("reads task ids where titles name them: in parentheses or after 'plan'", () => {
    expect(taskIds("feat(editor): [[ link completion (plan 4.5)", known)).toEqual(["4.5"]);
    expect(taskIds("ci(gate): lockfile drift; lanes resume (W8.9, W8.10) [skip ci]", known)).toEqual(["W8.9", "W8.10"]);
    expect(taskIds("feat(dictation): plan 6.1 local live dictation", known)).toEqual(["6.1"]);
    expect(taskIds("docs: the areas (plan 13.1.1) of 13.1", known)).toEqual(["13.1.1"]);
  });

  it("does not read a number in the title as a task", () => {
    expect(taskIds("perf(startup): startup JS on phones 2.0→0.9 MB (C1, C2, C5)", known)).toEqual([]);
    expect(taskIds("chore(deps): bump astro to 4.5.1 (v4.5.1)", known)).toEqual([]);
    expect(taskIds("fix: unknown task (plan 99.9)", known)).toEqual([]);
  });

  it("counts what a user sees: components, .tsx and new English strings; not tests or generated help", () => {
    expect(isUiFile("src/ui/CalendarPanel.tsx")).toBe(true);
    expect(isUiFile("src/components/Toolbar.ts")).toBe(true);
    expect(isUiFile("src/i18n/locales/en/files.json")).toBe(true);
    expect(isUiFile("src/i18n/lazy/unlinkedMentions.json")).toBe(true);
    expect(isUiFile("src/i18n/locales/he/files.json")).toBe(false);
    expect(isUiFile("src/storage/history.ts")).toBe(false);
    expect(isUiFile("src/__tests__/App.test.tsx")).toBe(false);
    expect(isUiFile("src/help/generated/help.en.0.json")).toBe(false);
    expect(isUiFile("scripts/train/build.mjs")).toBe(false);
  });

  it("an English docs page counts as the task's page; a Hebrew one alone does not", () => {
    expect(isDocsPage("docs/src/content/docs/workspace/links.md")).toBe(true);
    expect(isDocsPage("docs/src/content/docs/index.mdx")).toBe(true);
    expect(isDocsPage("docs/src/content/docs/he/workspace/links.md")).toBe(false);
    expect(isDocsPage("docs/dev/lanes.md")).toBe(false);
  });

  it("finished: ✅, code done, or built / verified", () => {
    expect(isFinished({ status: "✅ merged" })).toBe(true);
    expect(isFinished({ status: "⏳ קוד גמור — ממוזג ב-train-2" })).toBe(true);
    expect(isFinished({ status: "⏳ #506", verified: "built" })).toBe(true);
    expect(isFinished({ status: "⏳ #600 open" })).toBe(false);
    expect(isFinished({})).toBe(false);
  });

  it("finds every task in a plan, wherever it sits, once", () => {
    const plan = {
      phases: [{ id: "P1", tasks: [{ id: "4.5", title: "a", minutes: 1 }] }],
      waves: { W8: [{ id: "W8.10", title: "b", minutes: 2 }, { id: "4.5", title: "dup", minutes: 3 }] },
    };
    expect(planTasks(plan).map((t: { id: string; title: string }) => `${t.id}:${t.title}`)).toEqual(["4.5:a", "W8.10:b"]);
  });

  const tasks = [
    { id: "4.5", title: "link completion", minutes: 60, status: "✅" },
    { id: "4.6", title: "hover preview", minutes: 60, status: "⏳ קוד גמור" },
    { id: "6.1", title: "live dictation", minutes: 60, status: "⏳ קוד גמור" },
    { id: "0.9", title: "ci-doctor", minutes: 60, status: "✅", pr: 204 },
    { id: "13.1", title: "docs audit", minutes: 60, status: "⏳ open" },
  ];
  const prs = [
    { n: 217, t: "feat(editor): link completion (plan 4.5)", s: "open", m: false },
    { n: 250, t: "feat(links): hover preview (plan 4.6)", s: "closed", m: true },
    { n: 255, t: "feat(dictation): plan 6.1 live dictation", s: "open", m: false },
    { n: 204, t: "chore(dev): ci-doctor", s: "open", m: false },
    { n: 300, t: "docs: hover preview (plan 4.6)", s: "closed", m: false },
    { n: 316, t: "docs: every page (plan 13.1)", s: "open", m: false },
  ];
  const files: Record<number, string[] | null> = {
    217: ["src/editor/wikiComplete.ts", "src/i18n/locales/en/common.json"],
    250: ["src/renderer/hoverPreview.tsx"],
    255: ["src/ui/Dictation.tsx", "docs/src/content/docs/ai/hebrew-dictation.md"],
    204: ["scripts/ci-doctor.mjs"],
    300: ["docs/src/content/docs/workspace/hover.md"],
    316: ["src/ui/Help.tsx"],
  };
  const filesOf = (n: number) => files[n] ?? null;

  it("reports finished tasks with user-visible changes and no page, with their PRs and files", () => {
    const found = audit({ tasks, prs, filesOf });
    expect(found).toEqual([
      { id: "4.5", title: "link completion", prs: [217], ui: ["src/i18n/locales/en/common.json"] },
      // #300 was closed without merging: its page never landed
      { id: "4.6", title: "hover preview", prs: [250], ui: ["src/renderer/hoverPreview.tsx"] },
    ]);
    expect(formatFinding(found[0])).toMatch(/^4\.5 link completion — #217 changed 1 user-facing file \(src\/i18n\/locales\/en\/common\.json\) and wrote no page/);
  });

  it("a task its own PR documented, a dev-only task and an unfinished one are not reported", () => {
    const ids = audit({ tasks, prs, filesOf }).map((f: { id: string }) => f.id);
    expect(ids).not.toContain("6.1");
    expect(ids).not.toContain("0.9");
    expect(ids).not.toContain("13.1");
  });

  it("a task required-pages.json maps is not reported; nor a PR outside the audited ref, nor one whose files are unknown", () => {
    expect(audit({ tasks, prs, filesOf, mapped: { "4.5": "workspace/links", "4.6": "workspace/links" } })).toEqual([]);
    expect(audit({ tasks, prs, filesOf, inRef: (n: number) => n !== 217 }).map((f: { id: string }) => f.id)).toEqual(["4.6"]);
    expect(audit({ tasks, prs, filesOf: (n: number) => (n === 250 ? null : filesOf(n)) }).map((f: { id: string }) => f.id)).toEqual(["4.5"]);
  });
});
