/**
 * Plan W6.11, review 14.11: receipts that only the named reviewer could have
 * made (Ed25519, security/reviewers.json), only from accounts with write
 * access, naming what was read; and the coverage of a whole train
 * (scripts/review-coverage.mjs) against the acceptance "100% of the
 * sensitive PRs in trains 2 and 3 have a receipt on the head".
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalJson,
  commentReceipts,
  independentReviewVerdict,
  parseReviewers,
  receiptFor,
  receiptProblems,
  signatureProblems,
  // @ts-expect-error -- plain .mjs script, no types
} from "../../scripts/lib/independentReview.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { keygen, registryEntry, signReceipt } from "../../scripts/review-sign.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { coverageMarkdown, coverageOf, prsOfSubject, trainContents } from "../../scripts/review-coverage.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { parseCodeowners } from "../../scripts/lib/humanReview.mjs";

const HEAD = "3f80047a28d66e086ff2b50459353fc66e82b31d";
const sensitive = [{ file: "src/sync/e2ee/lan/rpc.ts", pattern: "/src/sync/e2ee/" }];
const receipt = (o: Record<string, unknown> = {}) => ({
  format: "lumen-review",
  version: 1,
  head: HEAD,
  author: "train-2",
  reviewer: "R",
  access: "read-only",
  date: "2026-11-14T12:00:00Z",
  files: ["/src/sync/e2ee/"],
  attackTests: [{ path: "src/__tests__/lanPreAuthAttack.test.ts", result: "6/6 pass" }],
  findings: [],
  verdict: "approve",
  ...o,
});

const r = keygen();
const other = keygen();
const registry = parseReviewers(JSON.stringify({ reviewers: { ...registryEntry("R", r.privatePem), ...registryEntry("S", other.privatePem) } }));

describe("signed receipts", () => {
  it("canonical JSON sorts keys at every level, so key order can't change what is signed", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: "é" } })).toBe('{"a":{"c":"é","d":[2,{"x":2,"y":1}]},"b":1}');
  });

  it("a receipt signed by the reviewer it names counts; with no registry nothing counts (W10.D3)", () => {
    expect(registry.problems).toEqual([]);
    const signed = signReceipt(receipt(), r.privatePem);
    expect(signatureProblems(signed, registry)).toEqual([]);
    expect(receiptFor(signed, HEAD, sensitive, registry)).toEqual([]);
    expect(receiptFor(receipt(), HEAD, sensitive, null).join()).toMatch(/security\/reviewers.json is missing/);
    expect(receiptFor(signed, HEAD, sensitive, null).join()).toMatch(/security\/reviewers.json is missing/);
    const v = independentReviewVerdict(sensitive, [{ source: "c", receipt: signed }], { head: HEAD, strict: true, reviewers: registry });
    expect(v.status).toBe("ok");
    expect(v.lines[0]).toMatch(/signature verified/);
  });

  it("unsigned, signed by another reviewer's key, changed after signing, or by an unknown reviewer: not counted", () => {
    expect(signatureProblems(receipt(), registry).join()).toMatch(/not signed/);
    // The author lane signs with its own key but names R as the reviewer.
    expect(signatureProblems(signReceipt(receipt(), other.privatePem), registry).join()).toMatch(/does not verify with R's key/);
    const changed = { ...signReceipt(receipt(), r.privatePem), verdict: "approve", findings: [{ id: "X", severity: "high", status: "fixed" }] };
    expect(signatureProblems(changed, registry).join()).toMatch(/does not verify/);
    expect(signatureProblems(signReceipt(receipt({ reviewer: "Q" }), r.privatePem), registry).join()).toMatch(/Q is not in security\/reviewers.json/);
    expect(receiptFor(receipt(), HEAD, sensitive, registry).join()).toMatch(/not signed/);
  });

  it("a registry entry that isn't an Ed25519 public key is reported", () => {
    expect(parseReviewers(JSON.stringify({ reviewers: { R: { publicKey: "bm90IGEga2V5" } } })).problems[0]).toMatch(/reviewer R: unusable public key/);
    expect(parseReviewers("{").problems[0]).toMatch(/not JSON/);
  });
});

describe("who may post, and what a receipt must name", () => {
  it("only comments by accounts with write access count", () => {
    const body = "```lumen-review\n" + JSON.stringify(receipt()) + "\n```";
    const got = commentReceipts([
      { id: 1, user: "talstilkol", association: "OWNER", body },
      { id: 2, user: "helper", association: "COLLABORATOR", body },
      { id: 3, user: "drive-by", association: "NONE", body },
      { id: 4, user: "old", association: "CONTRIBUTOR", body },
    ]);
    expect(got.map((g: { rejected?: string }) => !!g.rejected)).toEqual([false, false, true, true]);
    const v = independentReviewVerdict(sensitive, got.slice(2), { head: HEAD, strict: true });
    expect(v.status).toBe("fail");
    expect(v.lines.join("\n")).toMatch(/@drive-by has no write access/);
  });

  it("files that name the whole repository instead of what was read don't count", () => {
    for (const f of ["*", "**", "/", "/**", "**/*"]) expect(receiptProblems(receipt({ files: [f] })).join()).toMatch(/covers the whole repository/);
    expect(receiptProblems(receipt({ files: ["/src/sync/e2ee/", "src/lib/x.ts"] }))).toEqual([]);
  });
});

describe("a train's coverage (scripts/review-coverage.mjs)", () => {
  it("reads the PR numbers of train merge subjects", () => {
    expect(prsOfSubject("Merge #472 feat/vault-argon2id at 7f0bfc789 (with the fixed #399) [skip ci]")).toEqual([472]);
    expect(prsOfSubject("Merge #491 + #494 fix/vuln-deps [skip ci]")).toEqual([491, 494]);
    expect(prsOfSubject("Merge origin/verify/train into verify/train-2 [skip ci]")).toEqual([]);
  });

  it("every sensitive PR merged into the train, and the train's own commits, need a receipt for the head the train holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-revcov-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    const put = (p: string, t: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    };
    const commit = (m: string) => {
      g("add", "-A");
      g("commit", "-q", "-m", m);
      return g("rev-parse", "HEAD");
    };
    try {
      g("init", "-q", "-b", "main");
      g("config", "user.email", "t@example.org");
      g("config", "user.name", "T");
      put(".github/CODEOWNERS", "/src/sync/e2ee/ @talstilkol\n");
      put("src/a.ts", "export const a = 1;\n");
      commit("base");
      g("checkout", "-q", "-b", "pr10");
      put("src/sync/e2ee/kdf.ts", "export const n = 1;\n");
      const h10 = commit("feat: kdf");
      g("checkout", "-q", "-b", "pr11", "main");
      put("src/b.ts", "export const b = 1;\n");
      commit("feat: b (not sensitive)");
      g("checkout", "-q", "-b", "pr12", "main");
      put("src/sync/e2ee/lan.ts", "export const lan = 1;\n");
      const h12 = commit("feat: lan");
      g("checkout", "-q", "-b", "train", "main");
      for (const [b, n] of [["pr10", 10], ["pr11", 11], ["pr12", 12]] as const) g("merge", "-q", "--no-ff", "-m", `Merge #${n} ${b} [skip ci]`, b);
      put("src/sync/e2ee/kdf.ts", "export const n = 2; // integration fix\n");
      const trainHead = commit("fix: integration [skip ci]");

      const contents = trainContents(dir, "train", "main");
      expect(contents.prs.map((p: { number: number }) => p.number).sort()).toEqual([10, 11, 12]);
      expect(contents.own).toHaveLength(1);
      const entries = parseCodeowners("/src/sync/e2ee/ @talstilkol\n");
      const at = (head: string, o: Record<string, unknown> = {}) => ({ source: "file", receipt: signReceipt(receipt({ head, author: "K", ...o }), r.privatePem) });

      const none = coverageOf(contents, entries, { reviewers: registry });
      expect(none.sensitiveCount).toBe(3); // #10, #12 and the train's own fix; #11 isn't sensitive
      expect(none.percent).toBe(0);

      // A receipt for #10's head and #12's head, none for the train's own fix: 2 of 3.
      const two = coverageOf(contents, entries, { reviewers: registry, files: [at(h10, { pr: 10 }), at(h12)] });
      expect(two.covered).toBe(2);
      expect(two.percent).toBe(66.7);
      // A receipt for an older head of #12 does not count.
      expect(coverageOf(contents, entries, { reviewers: registry, files: [at(h10, { pr: 10 }), at("e".repeat(40), { pr: 12 })] }).covered).toBe(1);
      // The train's own commits: a receipt on the train head (through the train PR's comments).
      const all = coverageOf(contents, entries, { reviewers: registry, files: [at(h10, { pr: 10 }), at(h12)], trainPr: 99, receiptsFor: (n: number) => (n === 99 ? [at(trainHead)] : []) });
      expect(all.percent).toBe(100);
      const md = coverageMarkdown(all, "train");
      expect(md).toContain("3 of 3 sensitive change sets");
      expect(md).toContain("| train's own commits (#99) |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
