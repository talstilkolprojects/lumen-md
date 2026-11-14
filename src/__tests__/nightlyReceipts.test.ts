// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs module without type declarations
import { canonical, check, loadOrCreateKey, seal } from "../../scripts/nightly/receipt.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { ciLocalMetric, cleanMutationWeek, cleanNight, flakeStreak, mutationStreak, planStatus, scheduledKinds, weekOf } from "../../scripts/nightly/status.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { collectFlake, fetchMetricInputs, kindsDue, perfAnnotations, receiptForReport, reportName, stepsFor } from "../../scripts/nightly/run.mjs";

type Report = Record<string, unknown> & { receipt?: Record<string, string> };
const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const browsers = (over: Record<string, unknown> = {}) =>
  ["chromium", "firefox", "webkit"].map((browser) => ({ browser, times: 5, tests: 120, flaky: [], broken: [], ...over }));
const flake = (startedAt: string, over: Record<string, unknown> = {}) => ({ kind: "flake", trigger: "schedule", startedAt, steps: [{ status: 0 }], flake: { browsers: browsers(over) } });

describe("nightly receipts (plan W4.36)", () => {
  it("canonical JSON sorts keys at every depth and drops undefined", () => {
    expect(canonical({ b: 1, a: { d: [1, { z: 1, y: undefined, x: 2 }], c: "שלום" } })).toBe('{"a":{"c":"שלום","d":[1,{"x":2,"z":1}]},"b":1}');
  });

  it("a sealed report verifies; a changed number, a changed digest or another key does not", () => {
    const { priv, pub } = keys();
    const sealed = seal({ kind: "flake", flaky: 0, steps: [{ id: "e2e-flake", status: 0 }] }, priv) as Report;
    expect(sealed.receipt).toMatchObject({ alg: "ed25519" });
    expect(check(sealed, pub)).toEqual({ ok: true, problems: [] });
    expect(check({ ...sealed, flaky: 1 }, pub).problems).toEqual([expect.stringMatching(/digest does not match/), expect.stringMatching(/signature does not verify/)]);
    expect(check({ ...sealed, flaky: 1 }, null).problems).toEqual([expect.stringMatching(/digest does not match/)]);
    const forged = { ...sealed, flaky: 1 } as Report;
    forged.receipt = { ...sealed.receipt!, sha256: (seal({ ...forged, receipt: undefined }, keys().priv) as Report).receipt!.sha256 };
    expect(check(forged, pub).problems).toEqual([expect.stringMatching(/signature does not verify/)]);
    expect(check(sealed, keys().pub).problems).toEqual([expect.stringMatching(/another key/)]);
    expect(check({ kind: "x" }, pub)).toEqual({ ok: false, problems: ["no receipt"] });
    // Without the public key the digest is still checked.
    expect(check(sealed, null).ok).toBe(true);
  });

  it("the private key is made once, mode 0600, and its public half derives from it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-key-"));
    try {
      const path = join(dir, "sub", "k.pem");
      const a = loadOrCreateKey(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const b = loadOrCreateKey(path);
      expect(b.publicKeyPem).toBe(a.publicKeyPem);
      expect(check(seal({ x: 1 }, a.privateKeyPem), b.publicKeyPem).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan status from the reports (0.5, 0.11, 0.14)", () => {
  it("0.5: a clean night has every browser 5 times, tests found, nothing flaky or broken", () => {
    expect(cleanNight(flake("2026-11-13T01:00:00Z"))).toBe(true);
    expect(cleanNight(flake("2026-11-13T01:00:00Z", { flaky: ["t"] }))).toBe(false);
    expect(cleanNight(flake("2026-11-13T01:00:00Z", { broken: ["t"] }))).toBe(false);
    expect(cleanNight(flake("2026-11-13T01:00:00Z", { times: 4 }))).toBe(false);
    expect(cleanNight(flake("2026-11-13T01:00:00Z", { tests: 0 }))).toBe(false);
    const missing = flake("2026-11-13T01:00:00Z");
    (missing.flake.browsers as Array<Record<string, unknown>>)[2] = { browser: "webkit", missing: true };
    expect(cleanNight(missing)).toBe(false);
  });

  it("0.5: counts consecutive clean nights back from the latest; a gap or a bad night resets it", () => {
    const three = [flake("2026-11-13T01:00:00Z"), flake("2026-11-14T01:00:00Z"), flake("2026-11-15T01:00:00Z")];
    expect(flakeStreak(three)).toEqual({ nights: 3, days: ["2026-11-13", "2026-11-14", "2026-11-15"] });
    expect(flakeStreak([three[0], three[2]]).nights).toBe(1);
    expect(flakeStreak([...three, flake("2026-11-15T09:00:00Z", { flaky: ["x"] })]).nights).toBe(0);
    expect(flakeStreak([flake("2026-11-12T01:00:00Z", { flaky: ["x"] }), ...three]).nights).toBe(3);
    expect(flakeStreak([])).toEqual({ nights: 0, days: [] });
  });

  it("0.11: only scheduled reports count, one per kind", () => {
    const kinds = scheduledKinds([
      flake("2026-11-13T01:00:00Z"),
      { kind: "perf", trigger: "manual", startedAt: "2026-11-13T02:00:00Z", steps: [{ status: 0 }] },
      { kind: "triage", trigger: "schedule", startedAt: "2026-11-13T03:00:00Z", steps: [{ status: 1 }], commit: { sha: "abc" } },
    ]);
    expect(kinds.flake).toMatchObject({ ok: true });
    expect(kinds.perf).toBe(null);
    expect(kinds.triage).toEqual({ at: "2026-11-13T03:00:00Z", commit: "abc", ok: false });
    expect(kinds.weekly).toBe(null);
    const all = planStatus(["flake", "perf", "triage", "weekly"].map((kind) => ({ kind, trigger: "schedule", startedAt: "2026-11-15T01:00:00Z", steps: [] })));
    expect(all["0.11"]).toMatchObject({ ran: 4, needed: 4, met: true });
  });

  it("0.14: the first 20 PRs since the start, and every failing preview build among their commits", () => {
    const prs = Array.from({ length: 25 }, (_, i) => ({
      number: 500 + i,
      createdAt: `2026-11-${String(10 + Math.floor(i / 2)).padStart(2, "0")}T0${i % 2}:00:00Z`,
      commits: [{ sha: `a${i}`, state: i === 7 ? "failure" : "success" }, { sha: `b${i}`, state: i === 9 ? "error" : i === 3 ? "pending" : "success" }],
    }));
    const m = ciLocalMetric(prs, "2026-11-12");
    expect(m).toMatchObject({ prs: 20, of: 20, complete: true, remoteFailures: 2, prsWithFailures: [507, 509] });
    expect(planStatus([], m)["0.14"]).toMatchObject({ met: false });
    const clean = ciLocalMetric(prs.map((p) => ({ ...p, commits: [{ sha: "x", state: "success" }] })), "2026-11-12");
    expect(planStatus([], clean)["0.14"]).toMatchObject({ met: true, remoteFailures: 0 });
    expect(ciLocalMetric(prs.slice(0, 6), "2026-11-12")).toMatchObject({ prs: 2, complete: false });
    // The integration train and probes (verify/*) are not counted.
    expect(ciLocalMetric([{ ...prs[7], head: "verify/train" }], "2026-11-12")).toMatchObject({ prs: 0, remoteFailures: 0 });
  });

  it("0.14's inputs come from REST: PRs since the date, each commit's Vercel status", () => {
    const calls: string[] = [];
    const get = (path: string) => {
      calls.push(path);
      if (path.includes("/pulls?")) return [{ number: 4, head: { ref: "verify/probe" }, created_at: "2026-11-14T00:00:00Z" }, { number: 3, head: { ref: "feat/x" }, created_at: "2026-11-13T00:00:00Z" }, { number: 2, head: { ref: "fix/y" }, created_at: "2026-11-12T00:00:00Z" }, { number: 1, head: { ref: "z" }, created_at: "2026-11-01T00:00:00Z" }];
      if (path.endsWith("/commits?per_page=100")) return [{ sha: "s1" }];
      return { statuses: [{ context: "Lighthouse", state: "failure" }, { context: "Vercel", state: "success" }] };
    };
    expect(fetchMetricInputs("2026-11-12", get)).toEqual([
      { number: 2, head: "fix/y", createdAt: "2026-11-12T00:00:00Z", commits: [{ sha: "s1", state: "success" }] },
      { number: 3, head: "feat/x", createdAt: "2026-11-13T00:00:00Z", commits: [{ sha: "s1", state: "success" }] },
    ]);
    expect(calls.filter((c) => c.includes("/pulls?"))).toHaveLength(1);
  });
});

describe("the nightly runner", () => {
  it("runs flake, perf and triage every night, weekly on Sundays, or what --only names", () => {
    expect(kindsDue(new Date("2026-11-14T02:00:00Z"))).toEqual(["flake", "perf", "triage"]);
    expect(kindsDue(new Date("2026-11-15T02:00:00Z"))).toEqual(["flake", "perf", "triage", "weekly"]);
    expect(kindsDue(new Date("2026-11-14T02:00:00Z"), ["weekly", "triage"])).toEqual(["triage", "weekly"]);
  });

  it("names a report by day and kind, numbering a second run that day", () => {
    const taken = new Set(["/r/2026-11-14-flake.json", "/r/2026-11-14-flake-2.json"]);
    expect(reportName("/r", new Date("2026-11-14T02:00:00Z"), "flake", (p: string) => taken.has(p))).toBe("2026-11-14-flake-3.json");
    expect(reportName("/r", new Date("2026-11-14T02:00:00Z"), "perf", (p: string) => taken.has(p))).toBe("2026-11-14-perf.json");
  });

  it("runs the flake hunt on all three browsers 5 times; Lighthouse and mutation only where their scripts exist", () => {
    const none = () => false;
    expect(stepsFor("flake", none).map((s: { cmd: string[] }) => s.cmd.join(" "))).toEqual(["npm run e2e:flake -- --all --times 5"]);
    expect(stepsFor("perf", none).map((s: { id: string }) => s.id)).toEqual(["build", "budget", "perf-e2e"]);
    expect(stepsFor("perf", (s: string) => s === "lighthouse").map((s: { id: string }) => s.id)).toContain("lighthouse");
    expect(stepsFor("weekly", (s: string) => s === "test:mutation", () => false).map((s: { id: string }) => s.id)).toEqual(["weekly-health", "mutation"]);
    // W6.16: where the branch has the receipt check, the critical set runs under real vitest at the floor, then the check.
    const weekly = stepsFor("weekly", (s: string) => s === "test:mutation", (f: string) => f === "scripts/mutation/check.mjs");
    expect(weekly.map((s: { cmd: string[] }) => s.cmd.join(" "))).toEqual([
      "node scripts/nightly/weekly-health.mjs",
      "node scripts/mutation/run.mjs --critical --receipt --min 80",
      "node scripts/mutation/check.mjs",
    ]);
    expect(() => stepsFor("nope", none)).toThrow(/unknown kind/);
  });

  it("reads the flake hunt's summaries and the perf annotations", () => {
    const dir = mkdtempSync(join(tmpdir(), "flake-"));
    try {
      mkdirSync(join(dir, "chromium"));
      writeFileSync(join(dir, "chromium", "summary.json"), JSON.stringify({ times: 5, tests: { a: {}, b: {} }, flaky: ["b"], broken: [] }));
      expect(collectFlake(dir).browsers).toEqual([
        { browser: "chromium", times: 5, tests: 2, flaky: ["b"], broken: [] },
        { browser: "firefox", missing: true },
        { browser: "webkit", missing: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const pw = { suites: [{ specs: [{ tests: [{ annotations: [], results: [{ annotations: [{ type: "perf", description: "open: 640 ms" }, { type: "other", description: "x" }] }] }] }], suites: [{ specs: [{ tests: [{ annotations: [{ type: "perf", description: "search: 40 ms" }], results: [] }] }] }] }] };
    expect(perfAnnotations(pw)).toEqual(["open: 640 ms", "search: 40 ms"]);
  });
});

describe("W6.16: four weeks of real mutation receipts", () => {
  const receipt = (score: number, runner = "vitest") => ({ modules: { "src/sync/e2ee/age.ts": { score: 94, runner, sha256: "a", tests: "b" }, "src/sync/e2ee/keyring.ts": { score, runner, sha256: "c", tests: "d" } } });
  const weekly = (startedAt: string, score = 92.5, runner = "vitest", status = 0) => ({
    kind: "weekly",
    trigger: "schedule",
    startedAt,
    steps: [{ id: "weekly-health", status: 0 }, { id: "mutation-critical", status }, { id: "mutation-check", status: 0 }],
    mutationReceipt: receiptForReport(receipt(score, runner)),
  });

  it("the report carries each module's score, runner and hashes", () => {
    expect(receiptForReport(receipt(92.5))).toEqual({
      min: 80,
      modules: [
        { module: "src/sync/e2ee/age.ts", score: 94, runner: "vitest", sha256: "a", tests: "b" },
        { module: "src/sync/e2ee/keyring.ts", score: 92.5, runner: "vitest", sha256: "c", tests: "d" },
      ],
    });
    expect(receiptForReport(null)).toBe(null);
  });

  it("a week counts only when every critical module is at 80 or more under real vitest, the run and the check passed, and it was scheduled", () => {
    expect(cleanMutationWeek(weekly("2026-11-15T03:00:00Z"))).toBe(true);
    expect(cleanMutationWeek(weekly("2026-11-15T03:00:00Z", 79.9))).toBe(false);
    expect(cleanMutationWeek(weekly("2026-11-15T03:00:00Z", 92.5, "shim"))).toBe(false);
    expect(cleanMutationWeek(weekly("2026-11-15T03:00:00Z", 92.5, "vitest", 1))).toBe(false);
    expect(cleanMutationWeek({ ...weekly("2026-11-15T03:00:00Z"), trigger: "manual" })).toBe(false);
  });

  it("counts consecutive ISO weeks; a gap or a bad week breaks the streak", () => {
    expect(weekOf("2026-11-15T03:00:00Z")).toBe("2026-11-09"); // a Sunday belongs to the week of Monday 9.11
    const four = ["2026-11-15", "2026-11-22", "2026-11-29", "2026-12-06"].map((d) => weekly(`${d}T03:00:00Z`));
    expect(mutationStreak(four)).toMatchObject({ weeks: 4 });
    expect(planStatus(four)["W6.16"]).toMatchObject({ weeks: 4, needed: 4, met: true });
    expect(mutationStreak([four[0], four[1], four[3]]).weeks).toBe(1);
    expect(mutationStreak([...four.slice(0, 3), weekly("2026-12-06T03:00:00Z", 70)]).weeks).toBe(0);
    expect(planStatus([])["W6.16"]).toMatchObject({ weeks: 0, met: false });
  });
});
