/**
 * Plan W6.11: a sensitive change (.github/CODEOWNERS) needs an independent
 * review receipt for its head commit (scripts/lib/independentReview.mjs).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractReceipts,
  independentReviewVerdict,
  receiptComment,
  receiptFor,
  receiptProblems,
  uncovered,
  parseReviewers,
  commentReceipts,
  excludedIdentities,
  // @ts-expect-error -- plain .mjs script, no types
} from "../../scripts/lib/independentReview.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { keygen, registryEntry, signReceipt } from "../../scripts/review-sign.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { parseCodeowners, sensitiveChanges } from "../../scripts/lib/humanReview.mjs";

const HEAD = "3f80047a28d66e086ff2b50459353fc66e82b31d";
const entries = parseCodeowners(readFileSync(join(__dirname, "../../.github/CODEOWNERS"), "utf8"));
const sensitive = sensitiveChanges(["src/sync/e2ee/lan/rpc.ts", "src/__tests__/lanPreAuthAttack.test.ts", "src/storage/vault/atomic.ts"], entries);

const receipt = (o: Record<string, unknown> = {}) => ({
  format: "lumen-review",
  version: 1,
  pr: 495,
  head: HEAD,
  author: "train-2",
  reviewer: "S",
  access: "read-only",
  date: "2026-11-12T18:00:00Z",
  files: ["/src/sync/e2ee/", "src/storage/vault/atomic.ts"],
  attackTests: [{ path: "src/__tests__/lanPreAuthAttack.test.ts", result: "6/6 pass", failsWithoutFix: 3 }],
  findings: [{ id: "E56-1", severity: "medium", status: "fixed", summary: "device map before the proof", fix: "rev12/fixes/train2-lansync.patch" }],
  verdict: "approve",
  ...o,
});

// W10.D3: only a signed receipt counts, so the receipts here are signed with
// S's key and checked against a registry that lists it.
const sKey = keygen();
const registry = parseReviewers(JSON.stringify({ reviewers: registryEntry("S", sKey.privatePem) }));
const signed = (o: Record<string, unknown> = {}) => signReceipt(receipt(o), sKey.privatePem);

describe("review receipts", () => {
  it("only CODEOWNERS paths are sensitive here", () => {
    expect(sensitive.map((s: { file: string }) => s.file)).toEqual(["src/sync/e2ee/lan/rpc.ts", "src/storage/vault/atomic.ts"]);
  });

  it("a well-formed receipt for the head counts", () => {
    expect(receiptProblems(receipt())).toEqual([]);
    expect(receiptFor(signed(), HEAD, sensitive, registry)).toEqual([]);
    const v = independentReviewVerdict(sensitive, [{ source: "file", receipt: signed() }], { head: HEAD, strict: true, reviewers: registry });
    expect(v.status).toBe("ok");
    expect(v.lines[0]).toMatch(/by S \(author train-2, read-only\).*1 attack test, findings 1 medium/);
  });

  it("each rule that makes a review independent and complete", () => {
    const why = (o: Record<string, unknown>) => receiptFor(signed(o), HEAD, sensitive, registry).join(" | ");
    expect(why({ reviewer: "Train-2" })).toMatch(/reviewer is the author/);
    expect(why({ access: "write" })).toMatch(/read-only/);
    expect(why({ head: HEAD.slice(0, 9) })).toMatch(/40-character/);
    expect(why({ head: "f".repeat(40) })).toMatch(/not the head/);
    expect(why({ attackTests: [] })).toMatch(/attack test/);
    expect(why({ files: ["/src/sync/e2ee/"] })).toMatch(/does not cover 1 sensitive file: `src\/storage\/vault\/atomic.ts`/);
    expect(why({ findings: [{ id: "X", severity: "critical", status: "open" }] })).toMatch(/1 critical or high finding is open: X/);
    expect(why({ findings: [{ id: "X", severity: "high", status: "accepted" }] })).toBe("");
    expect(why({ findings: [{ id: "X", severity: "severe", status: "open" }] })).toMatch(/severity must be one of/);
    expect(why({ verdict: "changes-requested" })).toMatch(/verdict is "changes-requested"/);
    expect(why({ format: "other" })).toMatch(/format must be/);
  });

  it("files may be paths or CODEOWNERS patterns", () => {
    expect(uncovered(sensitive, ["src/sync/e2ee/lan/rpc.ts", "/src/storage/vault/"])).toEqual([]);
    expect(uncovered(sensitive, ["src/sync/"])).toEqual(["src/storage/vault/atomic.ts"]);
  });

  it("the comment form round-trips, and a broken block is reported, not skipped", () => {
    const text = `${receiptComment(receipt())}\n\nand\n\n\`\`\`lumen-review\n{ nope\n\`\`\``;
    const got = extractReceipts(text);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(receipt());
    expect(receiptProblems(got[1])[0]).toMatch(/not JSON/);
    expect(extractReceipts("```json\n{}\n```")).toEqual([]);
  });

  it("no receipt: a warning offline, a failure with --pr; a stale one next to a good one is listed", () => {
    expect(independentReviewVerdict(sensitive, [], { head: HEAD, strict: false }).status).toBe("warn");
    expect(independentReviewVerdict(sensitive, [], { head: HEAD, strict: true }).status).toBe("fail");
    expect(independentReviewVerdict([], [], { head: HEAD, strict: true }).status).toBe("ok");
    const v = independentReviewVerdict(
      sensitive,
      [
        { source: "comment 1", receipt: signed({ head: "a".repeat(40) }) },
        { source: "comment 2", receipt: signed() },
      ],
      { head: HEAD, strict: true, reviewers: registry },
    );
    expect(v.status).toBe("ok");
    expect(v.lines.join("\n")).toMatch(/comment 1: not counted — it is for `aaaaaaaaa`/);
    const stale = independentReviewVerdict(sensitive, [{ source: "comment 1", receipt: signed({ head: "a".repeat(40) }) }], { head: HEAD, strict: true, reviewers: registry });
    expect(stale.status).toBe("fail");
  });
});

/**
 * W10.D3 (research R3.3): the 8-case matrix. Only a receipt from an account
 * with write access, signed with the registered key of its reviewer, for the
 * head, by someone who neither opened the PR nor wrote or committed any of
 * its commits, counts.
 */
describe("W10.D3: who may approve", () => {
  const regWithIds = parseReviewers(JSON.stringify({ reviewers: { S: { ...registryEntry("S", sKey.privatePem).S, login: "s-reviewer", email: "s@example.org" } } }));
  const ctx = (o: Record<string, unknown> = {}) => ({ head: HEAD, strict: true, reviewers: regWithIds, ...o });
  const comment = (user: string, association: string, r: object) => ({ id: 1, user, association, body: receiptComment(r) });
  const verdict = (receipts: unknown[], o: Record<string, unknown> = {}) => independentReviewVerdict(sensitive, receipts, ctx(o));

  it("1. a valid signed receipt from a collaborator counts", () => {
    const v = verdict(commentReceipts([comment("s-reviewer", "COLLABORATOR", signed())], { prAuthor: "talstilkol" }));
    expect(v.status).toBe("ok");
    expect(v.lines[0]).toMatch(/signature verified/);
  });

  it("2. a stranger's receipt (author_association NONE or CONTRIBUTOR) is refused, even when validly signed", () => {
    for (const assoc of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", undefined]) {
      const v = verdict(commentReceipts([comment("stranger", assoc as string, signed())]));
      expect(v.status, String(assoc)).toBe("fail");
      expect(v.lines.join("\n")).toMatch(/has no write access/);
    }
  });

  it("3. the PR author's own receipt is refused, as a comment and by identity", () => {
    expect(verdict(commentReceipts([comment("s-reviewer", "OWNER", signed())], { prAuthor: "s-reviewer" })).lines.join("\n")).toMatch(/is the PR's author/);
    const ex = excludedIdentities({ prAuthor: "s-reviewer" });
    expect(verdict([{ source: "file", receipt: signed() }], { excluded: ex }).lines.join("\n")).toMatch(/S is the PR's author or wrote or committed a commit in its range/);
  });

  it("4. a receipt by an author or committer of a commit in the range is refused (by name or email)", () => {
    const byEmail = excludedIdentities({ commits: [{ authorName: "Someone", authorEmail: "x@example.org", committerName: "Other", committerEmail: "S@example.org" }] });
    expect(verdict([{ source: "file", receipt: signed() }], { excluded: byEmail }).status).toBe("fail");
    const byName = excludedIdentities({ commits: [{ authorName: "S", authorEmail: "y@example.org" }] });
    expect(verdict([{ source: "file", receipt: signed() }], { excluded: byName }).status).toBe("fail");
    const clean = excludedIdentities({ prAuthor: "talstilkol", commits: [{ authorName: "Claude", authorEmail: "noreply@anthropic.com" }] });
    expect(verdict([{ source: "file", receipt: signed() }], { excluded: clean }).status).toBe("ok");
  });

  it("5. a receipt for an older head is refused", () => {
    expect(verdict([{ source: "file", receipt: signed({ head: "b".repeat(40) }) }]).lines.join("\n")).toMatch(/not the head/);
  });

  it("6. an unsigned receipt is refused, and with no registry nothing counts", () => {
    expect(verdict([{ source: "file", receipt: receipt() }]).lines.join("\n")).toMatch(/not signed/);
    const none = independentReviewVerdict(sensitive, [{ source: "file", receipt: signed() }], { head: HEAD, strict: true, reviewers: null });
    expect(none.status).toBe("fail");
    expect(none.lines.join("\n")).toMatch(/security\/reviewers.json is missing, and an unsigned receipt does not count/);
  });

  it("7-9. tampering: a field changed after signing, a signature by another key, a reviewer swapped", () => {
    const t1 = { ...signed(), verdict: "approve", files: ["/src/"] };
    expect(verdict([{ source: "file", receipt: t1 }]).lines.join("\n")).toMatch(/does not verify/);
    const mallory = keygen();
    const t2 = signReceipt(receipt(), mallory.privatePem);
    expect(verdict([{ source: "file", receipt: t2 }]).lines.join("\n")).toMatch(/does not verify with S's key/);
    const t3 = { ...signed(), reviewer: "T" };
    expect(verdict([{ source: "file", receipt: t3 }]).lines.join("\n")).toMatch(/reviewer T is not in security\/reviewers.json/);
  });

  it("a catch-all file list never counts", () => {
    expect(verdict([{ source: "file", receipt: signed({ files: ["*"] }) }]).status).toBe("fail");
  });
});

