// @vitest-environment node
/**
 * Plan W6.7 — "real" is computed from signed receipts, not from text:
 * scripts/plan/receipts.mjs computes the level per task, and
 * scripts/plan/build.mjs holds the plan to it.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { byPhase, canonical, computeLevels, evidenceOf, fingerprint, verifySealed } from "../../scripts/plan/receipts.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { RECEIPTS_FILE, STATUS_MAX, checkRealReceipts, longStatuses, run } from "../../scripts/plan/build.mjs";

const ROOT = resolve(__dirname, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "lumen-receipts-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Obj = Record<string, unknown>;
const sha = (c: string) => c.repeat(40);
/** Seal like scripts/nightly/receipt.mjs (#455): sha256 + Ed25519 over the canonical JSON without `receipt`. */
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}
function seal(report: Obj, k: ReturnType<typeof keyPair>) {
  const text = canonical(report);
  return {
    ...report,
    receipt: {
      sha256: createHash("sha256").update(text).digest("hex"),
      alg: "ed25519",
      signature: sign(null, new TextEncoder().encode(text), k.privateKey).toString("base64"),
      key: createHash("sha256").update(createPublicKey(k.pem).export({ type: "spki", format: "pem" }).toString()).digest("hex").slice(0, 16),
    },
  };
}
const ok = { ok: true, detail: "ok" };
const bad = { ok: false, detail: "1 failed" };
const full = (commit: string, suites: Obj) => ({ version: 1, kind: "full", commit: { sha: commit, branch: "verify/train" }, suites });
const allE2e = { build: ok, vitest: ok, "e2e chromium": ok, "e2e firefox": ok, "e2e webkit": ok };

describe("receipts → levels (W6.7)", () => {
  it("verifies the #455 receipt format: a sealed report counts; an edit, another key or no seal does not", () => {
    const k = keyPair();
    const keys = new Map([[fingerprint(k.pem), k.pem]]);
    const r = seal(full(sha("a"), allE2e), k) as unknown as Obj & { suites: Obj };
    expect(verifySealed(r, keys)).toMatchObject({ ok: true });
    expect(verifySealed({ ...r, suites: { ...r.suites, "e2e webkit": ok, extra: ok } }, keys).problems[0]).toMatch(/digest does not match/);
    expect(verifySealed(r, new Map([[fingerprint(keyPair().pem), keyPair().pem]])).problems[0]).toMatch(/not trusted/);
    expect(verifySealed(full(sha("a"), allE2e), keys).problems).toEqual(["not sealed"]);
  });

  it("what each kind of receipt proves", () => {
    const t = { trusted: true };
    expect(evidenceOf(full(sha("a"), allE2e), t)).toMatchObject({ level: "browser", kind: "full" });
    expect(evidenceOf(full(sha("a"), { ...allE2e, "e2e webkit": bad }), t).level).toBe("node");
    expect(evidenceOf(full(sha("a"), { build: ok, vitest: bad }), t).level).toBe("built");
    expect(evidenceOf(full(sha("a"), { build: bad }), t).level).toBeNull();
    const flake = (broken: string[]) => ({ kind: "flake", commit: { sha: sha("b") }, flake: { browsers: ["chromium", "firefox", "webkit"].map((browser) => ({ browser, times: 5, tests: 300, flaky: [], broken })) } });
    expect(evidenceOf(flake([]), t).level).toBe("browser");
    expect(evidenceOf(flake(["x"]), t).level).toBeNull();
    const safari = (pass: boolean, tasks?: string[]) => ({ kind: "safari", commit: { sha: sha("c") }, real: { type: "device", tasks }, platforms: [{ name: "safari ios 17", ok: pass }] });
    expect(evidenceOf(safari(true, ["W6.1"]), t)).toMatchObject({ level: "real", tasks: ["W6.1"], type: "device" });
    expect(evidenceOf(safari(false, ["W6.1"]), t).level).toBeNull();
    expect(evidenceOf(safari(true), t).level).toBeNull(); // real must name its tasks
    expect(evidenceOf({ sha: sha("d"), gates: [{ gate: "build", ok: true }] }, t)).toMatchObject({ level: "node", kind: "vercel" });
    expect(evidenceOf(full(sha("a"), allE2e), { trusted: false })).toBeNull();
    expect(evidenceOf({ format: "lumen-review", version: 1 }, t)).toBeNull();
  });

  it("a receipt counts only on a commit that contains the PR's current head; real only for the tasks it names", () => {
    const head1 = sha("1");
    const head2 = sha("2");
    const train = sha("t");
    const graph: Record<string, string[]> = { [train]: [head1] }; // the train has head1, not the newer head2
    const contains = (h: string, c: string) => (graph[c] ?? []).includes(h);
    const evidence = [
      { commit: train, level: "browser", kind: "full", source: "commits/t/full.json" },
      { commit: train, level: "real", kind: "safari", tasks: ["A"], source: "commits/t/safari.json" },
    ];
    const tasks = [
      { id: "A", pr: 1, claimed: "real", phase: 0 },
      { id: "B", pr: 1, claimed: "real", phase: 0 },
      { id: "C", pr: 2, claimed: "browser", phase: 1 },
      { id: "D", claimed: "built", phase: 1 },
      { id: "E", pr: 3, claimed: "owner", phase: 1 },
    ];
    const reviews = [{ head: head1, verdict: "approve", reviewer: "lane R", source: "c1" }, { head: head2, verdict: "changes-requested", reviewer: "lane R", source: "c2" }];
    const r = computeLevels({ tasks, heads: { 1: head1, 2: head2, 3: sha("3") }, evidence, contains, reviews });
    expect(r.tasks.A).toMatchObject({ computed: "real", note: "matches", review: { reviewer: "lane R" } });
    expect(r.tasks.B).toMatchObject({ computed: "browser", note: "claims real without a receipt" });
    // PR 2 was pushed after the train was tested: its old evidence does not carry over (E62).
    expect(r.tasks.C).toMatchObject({ computed: null, note: "claims browser; receipts prove nothing", review: null });
    expect(r.tasks.D.note).toBe("no PR");
    expect(r.tasks.E.note).toBe("waits for the owner");
    expect(r.counts.computed).toEqual({ built: 0, node: 0, browser: 1, real: 1, none: 3 });
    expect(byPhase(r.tasks, ["p0", "p1"]).map((p: { tasks: number }) => p.tasks)).toEqual([2, 3]);
    // Missing git objects are counted, not guessed.
    expect(computeLevels({ tasks: [tasks[2]], heads: { 2: head2 }, evidence, contains: () => null }).unknown).toBe(1);
  });
});

describe("plan:check holds the plan to the receipts (W6.7)", () => {
  const plan = { phases: [{ title: "p", tasks: [{ id: "X", status: "✅", verified: "real" }, { id: "Y", status: "x".repeat(STATUS_MAX + 1), verified: "built" }, { id: "Z", status: "א".repeat(STATUS_MAX) }] }] };

  it("refuses real without a receipt that proves it, and lists statuses over 200 characters", () => {
    expect(checkRealReceipts(plan, null)).toEqual([`X: verified "real" but ${RECEIPTS_FILE} has no entry for it (run scripts/plan/receipts.mjs)`]);
    expect(checkRealReceipts(plan, { tasks: { X: { computed: "browser" } } })).toEqual(['X: verified "real" but its receipts prove browser']);
    expect(checkRealReceipts(plan, { tasks: { X: { computed: "real" } } })).toEqual([]);
    expect(longStatuses(plan)).toEqual(["Y"]); // counted in characters, not UTF-16 units or bytes
  });

  it("the board shows the computed levels when the receipts file is there, and is unchanged without it", () => {
    const dir = join(tmp, "with");
    mkdirSync(join(dir, "plan"), { recursive: true });
    for (const f of ["plan/plan.json", "plan/board.html", "MASTER_PLAN.md"]) cpSync(join(ROOT, f), join(dir, f));
    expect(run({ root: dir, check: true }).stale).toEqual([]);
    const p = JSON.parse(readFileSync(join(dir, "plan/plan.json"), "utf8"));
    const counts = { built: 2, node: 1, browser: 4, real: 0, none: 9 };
    writeFileSync(join(dir, RECEIPTS_FILE), JSON.stringify({ version: 1, generatedAt: "2026-11-13T07:00:00.000Z", counts: { computed: counts }, byPhase: p.phases.map(() => ({ computed: counts })), tasks: {} }));
    expect(run({ root: dir }).stale).toEqual(["MASTER_PLAN.md", "plan/board.html"]);
    const doc = readFileSync(join(dir, "MASTER_PLAN.md"), "utf8");
    expect(doc).toContain("**רמת אימות מקבלות חתומות (`plan/verified-receipts.json`, 2026-11-13T07:00):** נבנה בלבד 2 · Node 1 · דפדפן 4 · אמיתי (מוזג) 0 · בלי קבלה 9");
    expect(readFileSync(join(dir, "plan/board.html"), "utf8")).toContain("0 אמיתי מקבלות");
    expect(() => run({ root: dir, check: true, strictStatus: true })).toThrow(/longer than 200 characters/);
  });
});
