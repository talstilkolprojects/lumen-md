/**
 * Plan W4.28: sensitive paths (.github/CODEOWNERS) need the `human-reviewed`
 * label, added after the last commit, before `npm run pr:check -- --pr <n>`
 * passes (scripts/lib/humanReview.mjs).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  codeownersMatch,
  HUMAN_REVIEW_LABEL,
  codeownersSections,
  humanReviewVerdict,
  independentPatterns,
  parseCodeowners,
  sensitiveChanges,
  // @ts-expect-error -- plain .mjs script, no types
} from "../../scripts/lib/humanReview.mjs";

const OWNERS = readFileSync(join(__dirname, "../../.github/CODEOWNERS"), "utf8");
const entries = parseCodeowners(OWNERS);

describe("CODEOWNERS patterns", () => {
  it("anchors /dir/ at the root and covers everything under it", () => {
    expect(codeownersMatch("/src/sync/e2ee/", "src/sync/e2ee/kdf.ts")).toBe(true);
    expect(codeownersMatch("/src/sync/e2ee/", "src/sync/e2ee/providers/dropbox.ts")).toBe(true);
    expect(codeownersMatch("/src/sync/e2ee/", "lib/src/sync/e2ee/kdf.ts")).toBe(false);
    expect(codeownersMatch("/src/sync/e2ee/", "src/sync/e2ee.ts")).toBe(false);
  });
  it("matches a file exactly, not a longer name", () => {
    expect(codeownersMatch("/src/ai/privacyLedger.ts", "src/ai/privacyLedger.ts")).toBe(true);
    expect(codeownersMatch("/src/ai/privacyLedger.ts", "src/ai/privacyLedger.tsx")).toBe(false);
  });
  it("matches a bare name or glob at any depth, * within one segment, ** across", () => {
    expect(codeownersMatch("*.rs", "src-tauri/src/lib.rs")).toBe(true);
    expect(codeownersMatch("/src/*.ts", "src/a.ts")).toBe(true);
    expect(codeownersMatch("/src/*.ts", "src/a/b.ts")).toBe(false);
    expect(codeownersMatch("/src/**/crypto.ts", "src/a/b/crypto.ts")).toBe(true);
    expect(codeownersMatch("/src/**/crypto.ts", "src/crypto.ts")).toBe(true);
    expect(codeownersMatch("docs/", "a/docs/x.md")).toBe(true);
  });
  it("drops comments and blank lines", () => {
    expect(parseCodeowners("# x\n\n/a/ @o # note\n/b @p @q\n")).toEqual([
      { pattern: "/a/", owners: ["@o"] },
      { pattern: "/b", owners: ["@p", "@q"] },
    ]);
  });
});

describe("the repository's sensitive paths", () => {
  it.each([
    "src/sync/e2ee/keys.ts",
    "src/collab/encryption.ts",
    "src/storage/vault/encrypted/format.ts",
    "src/storage/vault/opfs.ts",
    "src-tauri/vault/src/lib.rs",
    "src-tauri/src/lib.rs",
    "src/ai/privacyLedger.ts",
    "src/build/cspEndpoints.ts",
    "public/_headers",
    "deploy/vercel.base.json",
    "security/policy.json",
    "src-tauri/capabilities/default.json",
    ".github/CODEOWNERS",
  ])("%s is sensitive", (file) => {
    expect(sensitiveChanges([file], entries)).toHaveLength(1);
  });
  it.each(["src/components/Toolbar.tsx", "docs/src/content/docs/index.mdx", "README.md", "src/i18n/he.json"])("%s is not", (file) => {
    expect(sensitiveChanges([file], entries)).toEqual([]);
  });
});

describe("the verdict", () => {
  const sensitive = [{ file: "src/sync/e2ee/kdf.ts", pattern: "/src/sync/e2ee/" }];
  const pr = (over: Record<string, unknown> = {}) => ({
    number: 7,
    labels: [HUMAN_REVIEW_LABEL],
    events: [{ event: "labeled", label: HUMAN_REVIEW_LABEL, created_at: "2026-11-12T10:00:00Z", actor: "talstilkol" }],
    reviews: [],
    author: "talstilkol",
    headSha: "abc",
    headDate: "2026-11-12T09:00:00Z",
    ...over,
  });

  it("passes when nothing sensitive changed, with or without a PR", () => {
    expect(humanReviewVerdict([], null).status).toBe("ok");
    expect(humanReviewVerdict([], pr({ labels: [] })).status).toBe("ok");
  });
  it("only warns before the PR number is given", () => {
    const v = humanReviewVerdict(sensitive, null);
    expect(v.status).toBe("warn");
    expect(v.lines.join("\n")).toContain("src/sync/e2ee/kdf.ts");
  });
  it("fails without the label", () => {
    const v = humanReviewVerdict(sensitive, pr({ labels: ["ai-written"] }));
    expect(v.status).toBe("fail");
    expect(v.lines[0]).toContain(HUMAN_REVIEW_LABEL);
  });
  it("fails when a commit came after the label", () => {
    const v = humanReviewVerdict(sensitive, pr({ headDate: "2026-11-12T11:00:00Z" }));
    expect(v.status).toBe("fail");
    expect(v.lines[0]).toContain("before the last commit");
  });
  it("uses the newest labeled event (removed and re-added after a push)", () => {
    const events = [
      { event: "labeled", label: HUMAN_REVIEW_LABEL, created_at: "2026-11-12T08:00:00Z", actor: "talstilkol" },
      { event: "unlabeled", label: HUMAN_REVIEW_LABEL, created_at: "2026-11-12T09:30:00Z", actor: "talstilkol" },
      { event: "labeled", label: HUMAN_REVIEW_LABEL, created_at: "2026-11-12T10:00:00Z", actor: "talstilkol" },
    ];
    expect(humanReviewVerdict(sensitive, pr({ events })).status).toBe("ok");
  });
  it("fails when the label is there but its event is not", () => {
    expect(humanReviewVerdict(sensitive, pr({ events: [] })).status).toBe("fail");
  });
  it("passes with the label after the last commit and names a second account's approval", () => {
    const ok = humanReviewVerdict(sensitive, pr());
    expect(ok.status).toBe("ok");
    expect(ok.lines.join("\n")).toContain("No approval from a second account");
    const reviews = [
      { user: "talstilkol", state: "APPROVED", commit_id: "abc" },
      { user: "maintainer2", state: "APPROVED", commit_id: "abc" },
      { user: "maintainer3", state: "APPROVED", commit_id: "old" },
    ];
    const two = humanReviewVerdict(sensitive, pr({ reviews }));
    expect(two.lines.join("\n")).toContain("@maintainer2");
    expect(two.lines.join("\n")).not.toContain("@maintainer3");
  });
});

describe("cryptography needs an independent reviewer (W6.13)", () => {
  const independent = independentPatterns(OWNERS);
  const crypto = [{ file: "src/sync/e2ee/kdf.ts", pattern: "/src/sync/e2ee/" }];
  const csp = [{ file: "public/_headers", pattern: "/public/_headers" }];
  const pr = (actor: string, author = "claude-agent") => ({
    number: 8,
    labels: [HUMAN_REVIEW_LABEL],
    events: [{ event: "labeled", label: HUMAN_REVIEW_LABEL, created_at: "2026-11-12T10:00:00Z", actor }],
    reviews: [],
    author,
    headSha: "abc",
    headDate: "2026-11-12T09:00:00Z",
  });
  const rule = { independent, owner: "talstilkol" };

  it("reads the Cryptography section of the repository's CODEOWNERS, and only it", () => {
    expect(independent.has("/src/sync/e2ee/")).toBe(true);
    expect(independent.has("/src/plugins/signing.ts")).toBe(true);
    expect(independent.has("/public/_headers")).toBe(false);
    expect(independent.has("/src/storage/vault/")).toBe(false);
    const sections = codeownersSections(OWNERS) as { pattern: string; section: string }[];
    expect(sections.find((e) => e.pattern === "/src/sync/e2ee/")?.section).toMatch(/^Cryptography/);
  });

  it("fails a crypto change labelled by the owner or the author, passes one labelled by someone else", () => {
    const byOwner = humanReviewVerdict(crypto, pr("talstilkol"), HUMAN_REVIEW_LABEL, rule);
    expect(byOwner.status).toBe("fail");
    expect(byOwner.lines[0]).toMatch(/repository owner \(@talstilkol\)/);
    const byAuthor = humanReviewVerdict(crypto, pr("dev1", "dev1"), HUMAN_REVIEW_LABEL, rule);
    expect(byAuthor.status).toBe("fail");
    expect(byAuthor.lines[0]).toMatch(/author \(@dev1\)/);
    expect(humanReviewVerdict(crypto, pr("maintainer2"), HUMAN_REVIEW_LABEL, rule).status).toBe("ok");
  });

  it("leaves the other sensitive areas to any person, the owner included", () => {
    expect(humanReviewVerdict(csp, pr("talstilkol"), HUMAN_REVIEW_LABEL, rule).status).toBe("ok");
  });

  it("an unknown labelling account does not count for cryptography", () => {
    const p = { ...pr("x"), events: [{ event: "labeled", label: HUMAN_REVIEW_LABEL, created_at: "2026-11-12T10:00:00Z", actor: "" }] };
    expect(humanReviewVerdict(crypto, p, HUMAN_REVIEW_LABEL, rule).status).toBe("fail");
  });
});
