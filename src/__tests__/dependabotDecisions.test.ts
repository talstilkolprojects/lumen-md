/**
 * W10.D10 (plan W6.14): every dependabot PR has one decision in
 * docs/security/dependabot.md, from a fixed set, and the totals in the
 * document add up to its rows. The npm lockfiles have no open high or
 * critical advisory in security/known-bad.json.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/security/dependabot.md", "utf8");
const rows = doc
  .split("\n")
  .filter((l) => /^\| #\d+ \|/.test(l))
  .map((l) => {
    const [, pr, update, decision, reason] = l.split("|").map((c) => c.trim());
    return { pr, update, decision, reason };
  });
const kind = (d: string) =>
  /^\*\*Superseded by #\d+\*\*$/.test(d) ? "superseded" : /^\*\*Close, not used\*\*$/.test(d) ? "close" : /^\*\*Safe → deps train[^*]*\*\*$/.test(d) ? "safe" : /^\*\*Major( migration|: decline)\*\*$/.test(d) ? "major" : null;

describe("dependabot decisions", () => {
  it("each PR appears once, with a decision from the fixed set and a reason", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.pr)).size).toBe(rows.length);
    for (const r of rows) {
      expect(kind(r.decision), `${r.pr}: ${r.decision}`).not.toBeNull();
      expect(r.reason.length, r.pr).toBeGreaterThan(3);
    }
  });

  it("the totals add up to the rows", () => {
    const by = (k: string) => rows.filter((r) => kind(r.decision) === k).length;
    expect(doc).toContain(`**Count:** ${rows.length} PRs.`);
    expect(doc).toMatch(new RegExp(`\\| Superseded \\| ${by("superseded")} \\|`));
    expect(doc).toMatch(new RegExp(`\\| Close, not used \\| ${by("close")} \\|`));
    expect(doc).toMatch(new RegExp(`\\| Safe for the dependency train \\| ${by("safe")} \\|`));
    expect(doc).toMatch(new RegExp(`\\| Major \\| ${by("major")} `));
  });

  it("a PR superseded by another dependabot PR names one that is in the table", () => {
    const prs = new Set(rows.map((r) => r.pr));
    for (const r of rows) {
      const m = /Superseded by (#\d+)/.exec(r.decision);
      if (m && !["#494", "#499"].includes(m[1])) expect(prs.has(m[1]), `${r.pr} → ${m[1]}`).toBe(true);
    }
  });

  it("no high or critical advisory is open in an npm lockfile", () => {
    const { entries } = JSON.parse(readFileSync("security/known-bad.json", "utf8")) as { entries: { file: string; severity?: string; status: string; name: string }[] };
    const openHigh = entries.filter((e) => e.file.endsWith("package-lock.json") && e.status === "open" && ["high", "critical"].includes(String(e.severity)));
    expect(openHigh.map((e) => `${e.file}: ${e.name}`)).toEqual([]);
  });
});
