/**
 * Pure helpers of scripts/review-triage.mjs and scripts/review-reply.mjs
 * (scripts/lib/review.mjs): severity badges, finding titles, lane
 * suggestions, the decisions table and the reply bodies. The CLIs
 * themselves talk to GitHub through `gh` and are not driven from here.
 */
import { describe, it, expect } from "vitest";

import {
  buildReplyBody,
  extractSeverity,
  findingTitle,
  groupByFile,
  parseDecisions,
  parseReplied,
  prFromUrl,
  shortAuthor,
  shouldResolve,
  suggestLane,
  triageRows,
  // @ts-expect-error — plain .mjs helper without type declarations
} from "../../scripts/lib/review.mjs";

const codexBody = (sev: string, title: string) =>
  `**<sub><sub>![${sev} Badge](https://img.shields.io/badge/${sev}-orange?style=flat)</sub></sub>  ${title}**\n\nWhen a user shares twice…\n\nUseful? React with 👍 / 👎.\n\n<!-- codex-code-review-finding:v1 -->`;

describe("extractSeverity", () => {
  it("reads the Codex badge", () => {
    expect(extractSeverity(codexBody("P1", "Assign a unique tab name"))).toBe("P1");
    expect(extractSeverity(codexBody("P2", "Preserve file handles"))).toBe("P2");
  });
  it("reads a shields.io URL without the alt text", () => {
    expect(extractSeverity("![x](https://img.shields.io/badge/P0-red) Data loss")).toBe("P0");
  });
  it("reads a plain P-prefix on the first line", () => {
    expect(extractSeverity("P2: the retry loop never stops")).toBe("P2");
    expect(extractSeverity("[P3] typo in the hint")).toBe("P3");
    expect(extractSeverity("**P1** wrong key")).toBe("P1");
  });
  it("is empty when there is no badge", () => {
    expect(extractSeverity("Looks good, but rename this")).toBe("");
    expect(extractSeverity("Please check P1 later in the body")).toBe("");
    expect(extractSeverity(undefined)).toBe("");
  });
});

describe("findingTitle", () => {
  it("strips the Codex badge and bold markers", () => {
    expect(findingTitle(codexBody("P1", "Assign a unique tab name to every shared note"))).toBe(
      "Assign a unique tab name to every shared note",
    );
  });
  it("skips blank lines and keeps link text", () => {
    expect(findingTitle("\n\n`foo` breaks [the spec](https://x.y/z) here\nmore")).toBe("foo breaks the spec here");
  });
  it("drops a plain severity prefix", () => {
    expect(findingTitle("P2: the retry loop never stops")).toBe("the retry loop never stops");
  });
});

describe("suggestLane", () => {
  it.each([
    ["src/storage/vault.ts", "S"],
    ["src/sync/git.ts", "S"],
    ["src/collab/yjs.ts", "S"],
    ["src/ai/ocr.ts", "A"],
    ["src/agents/runtime.ts", "A"],
    ["src/ui/StatusBar.tsx", "U"],
    ["src/i18n/index.ts", "U"],
    ["i18n/keys.json", "U"],
    ["scripts/pr-status.mjs", "D"],
    [".github/workflows/ci.yml", "D"],
    ["src/build/cspEndpoints.ts", "D"],
    ["vite.config.ts", "D"],
    ["src/App.tsx", ""],
    ["MASTER_PLAN.md", ""],
  ])("%s → %s", (path, lane) => {
    expect(suggestLane(path)).toBe(lane);
  });
});

describe("small helpers", () => {
  it("prFromUrl", () => {
    expect(prFromUrl("https://api.github.com/repos/o/r/pulls/193")).toBe(193);
    expect(prFromUrl("https://api.github.com/repos/o/r/issues/5")).toBeNull();
  });
  it("shortAuthor", () => {
    expect(shortAuthor("chatgpt-codex-connector[bot]")).toBe("codex");
    expect(shortAuthor("dependabot[bot]")).toBe("dependabot");
    expect(shortAuthor("talstilkol")).toBe("talstilkol");
  });
  it("shouldResolve: everything but wontfix", () => {
    expect([shouldResolve("fixed"), shouldResolve("already-fixed"), shouldResolve("wontfix")]).toEqual([true, true, false]);
  });
});

describe("triageRows + groupByFile", () => {
  const threads = [
    { resolved: false, outdated: false, path: "src/App.tsx", line: 213, comment_ids: [3] },
    { resolved: true, outdated: false, path: "src/App.tsx", line: 1, comment_ids: [9] },
    { resolved: false, outdated: true, path: "src/App.tsx", line: null, comment_ids: [1, 2] },
    { resolved: false, outdated: false, path: "src/ai/ocr.ts", line: 65, comment_ids: [4] },
  ];
  const comments = new Map<number, unknown>([
    [1, { id: 1, body: codexBody("P1", "First"), user: { login: "chatgpt-codex-connector[bot]" }, original_line: 200 }],
    [2, { id: 2, body: "Fixed in abc", user: { login: "talstilkol" } }],
    [3, { id: 3, body: codexBody("P2", "Second"), user: { login: "chatgpt-codex-connector[bot]" } }],
    [4, { id: 4, body: "nit: rename", user: { login: "someone" } }],
  ]);

  it("keeps unresolved threads with their first comment's details", () => {
    const rows = triageRows(193, threads, comments);
    expect(rows.map((r: { comment_id: number }) => r.comment_id)).toEqual([3, 1, 4]);
    const outdated = rows.find((r: { comment_id: number }) => r.comment_id === 1);
    expect(outdated).toMatchObject({ pr: 193, line: 200, outdated: true, severity: "P1", title: "First", replies: 1, last_author: "talstilkol" });
  });

  it("groups by file, sorted, rows by PR then line", () => {
    const groups = groupByFile(triageRows(193, threads, comments));
    expect(groups.map(([p]: [string]) => p)).toEqual(["src/ai/ocr.ts", "src/App.tsx"]);
    expect(groups[1][1].map((r: { line: number }) => r.line)).toEqual([200, 213]);
  });
});

describe("parseDecisions", () => {
  it("parses the table, skipping header, blanks and comments", () => {
    const { rows, errors } = parseDecisions(
      [
        "comment_id\tverdict\tsha\treason",
        "",
        "# lane S",
        "4305258504\tfixed\t1a2b3c4\tunique tab names",
        "4305258507\talready-fixed\t9f8e7d6c5b\tkept since the rewrite",
        "4305265210\twontfix\t-\tintended\twith a tab inside",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 4, comment_id: 4305258504, verdict: "fixed", sha: "1a2b3c4", reason: "unique tab names" },
      { line: 5, comment_id: 4305258507, verdict: "already-fixed", sha: "9f8e7d6c5b", reason: "kept since the rewrite" },
      { line: 6, comment_id: 4305265210, verdict: "wontfix", sha: "", reason: "intended\twith a tab inside" },
    ]);
  });

  it("finds the header after a leading blank line or comment, and only as the first row", () => {
    const { rows, errors } = parseDecisions(["", "# decisions for #203", "comment_id\tverdict\tsha\treason", "4305258504\tfixed\t1a2b3c4\tunique tab names"].join("\n"));
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ line: 4, comment_id: 4305258504, verdict: "fixed", sha: "1a2b3c4", reason: "unique tab names" }]);
    // A header-like row after the first data row is data, and an error.
    const late = parseDecisions(["4305258504\tfixed\t1a2b3c4\tok", "comment_id\tverdict\tsha\treason"].join("\n"));
    expect(late.errors).toContain('line 2: comment_id "comment_id" is not a number');
  });

  it("collects every problem with its line number", () => {
    const { errors } = parseDecisions(
      ["12\tfixd\t-\tx", "abc\tfixed\tzz\t", "1\tfixed\t1a2b3c4", "5\twontfix\tnot-a-sha\twhy", "7\tfixed\tabcdef1\ta", "7\tfixed\tabcdef1\tb"].join(
        "\n",
      ),
    );
    expect(errors).toEqual([
      'line 1: verdict "fixd" is not one of fixed|already-fixed|wontfix',
      'line 2: comment_id "abc" is not a number',
      'line 2: fixed needs a commit sha (7–40 hex), got "zz"',
      "line 2: reason is empty",
      "line 3: expected 4 tab-separated columns, got 3",
      'line 4: sha "not-a-sha" should be "-" or a commit sha',
      "line 6: comment 7 appears twice",
    ]);
  });

  it("accepts CRLF line endings and upper-case verdicts", () => {
    const { rows, errors } = parseDecisions("1\tFIXED\tabcdef1\tok\r\n2\tWontFix\t\tno\r\n");
    expect(errors).toEqual([]);
    expect(rows.map((r: { verdict: string }) => r.verdict)).toEqual(["fixed", "wontfix"]);
  });
});

describe("buildReplyBody", () => {
  it("fixed", () => {
    expect(buildReplyBody({ verdict: "fixed", sha: "1a2b3c4", reason: "unique tab names" }, 200)).toBe(
      "Fixed in 1a2b3c4 — unique tab names\n\nMerged with the other review fixes in #200.",
    );
  });
  it("already-fixed", () => {
    expect(buildReplyBody({ verdict: "already-fixed", sha: "9f8e7d6", reason: "kept since the rewrite" }, 200)).toBe(
      "Already fixed in 9f8e7d6 — kept since the rewrite\n\nNo further change needed; noted with the other review fixes in #200.",
    );
  });
  it("wontfix", () => {
    expect(buildReplyBody({ verdict: "wontfix", sha: "", reason: "intended" }, 200)).toBe(
      "Not changing this — intended\n\nLeaving the thread open in case you see it differently (review fixes: #200).",
    );
  });
  it("rejects an unknown verdict", () => {
    expect(() => buildReplyBody({ verdict: "maybe", sha: "", reason: "" }, 1)).toThrow(/unknown verdict/);
  });
});

describe("parseReplied", () => {
  it("done ids, partial replies, and done winning over partial", () => {
    const s = parseReplied("11\n22 replied\n33 replied\n33\n\nnoise\n");
    expect([...s.entries()]).toEqual([
      [11, "done"],
      [22, "replied"],
      [33, "done"],
    ]);
  });
});
