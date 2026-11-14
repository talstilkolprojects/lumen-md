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
  // @ts-expect-error -- plain .mjs script, no types
} from "../../scripts/lib/independentReview.mjs";
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

describe("review receipts", () => {
  it("only CODEOWNERS paths are sensitive here", () => {
    expect(sensitive.map((s: { file: string }) => s.file)).toEqual(["src/sync/e2ee/lan/rpc.ts", "src/storage/vault/atomic.ts"]);
  });

  it("a well-formed receipt for the head counts", () => {
    expect(receiptProblems(receipt())).toEqual([]);
    expect(receiptFor(receipt(), HEAD, sensitive)).toEqual([]);
    const v = independentReviewVerdict(sensitive, [{ source: "file", receipt: receipt() }], { head: HEAD, strict: true });
    expect(v.status).toBe("ok");
    expect(v.lines[0]).toMatch(/by S \(author train-2, read-only\).*1 attack test, findings 1 medium/);
  });

  it("each rule that makes a review independent and complete", () => {
    const why = (o: Record<string, unknown>) => receiptFor(receipt(o), HEAD, sensitive).join(" | ");
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
        { source: "comment 1", receipt: receipt({ head: "a".repeat(40) }) },
        { source: "comment 2", receipt: receipt() },
      ],
      { head: HEAD, strict: true },
    );
    expect(v.status).toBe("ok");
    expect(v.lines.join("\n")).toMatch(/comment 1: not counted — it is for `aaaaaaaaa`/);
    const stale = independentReviewVerdict(sensitive, [{ source: "comment 1", receipt: receipt({ head: "a".repeat(40) }) }], { head: HEAD, strict: true });
    expect(stale.status).toBe("fail");
  });
});
