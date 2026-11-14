/**
 * Plan W6.26 — a budget that only goes down: the ratchet after a train,
 * exceptions with an expiry date, the loosening checks pr:check and
 * budget:history use, and the real bundle-budget.mjs on a real dist/.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  budgetRaises,
  expiredExceptions,
  lighthouseRaises,
  measuredFromSizes,
  parseFirstParty,
  perfRaises,
  ratchet,
  ratchetPerf,
  sampleName,
  today,
  validateBudgets,
  withMargin,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/budgetRatchet.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { checkHistory, parseArgs, run, sizesFromLog } from "../../scripts/budget-ratchet.mjs";

const ROOT = resolve(__dirname, "../..");
const REAL = JSON.parse(readFileSync(join(ROOT, "scripts/bundle-budgets.json"), "utf8"));

type Rule = { name: string; pattern: string; budgetKb: number; expires?: string; task?: string };
const spec = (rules: Rule[], startup = 460) => ({ margin: { pct: 2, minKb: 1 }, startup: { budgetKb: startup }, rules, history: [] as unknown[] });
const base = (): Rule[] => [
  { name: "main bundle", pattern: "^app-", budgetKb: 195 },
  { name: "vendor: excalidraw core", pattern: "^vendor-excalidraw-chunk-EIO257PC-", budgetKb: 740, expires: "2027-01-15", task: "W1.36" },
  { name: "vendor: excalidraw", pattern: "^vendor-excalidraw-", budgetKb: 700 },
  { name: "vendor: other", pattern: "^vendor-", budgetKb: 200 },
  { name: "lazy: ts checker", pattern: "^tsCheck\\.worker-", budgetKb: 1450 },
  { name: "lazy plugin chunk", pattern: "\\.js$", budgetKb: 100 },
];

describe("the budgets file", () => {
  it("is valid, and every exception in it has an expiry date and a task", () => {
    expect(validateBudgets(REAL)).toEqual([]);
    const exceptions = REAL.rules.filter((r: Rule) => r.expires || r.task);
    expect(exceptions.map((r: Rule) => r.name)).toContain("vendor: excalidraw core");
    for (const r of exceptions) {
      expect(r.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.task).toMatch(/\S/);
    }
  });

  it("every rule's pattern is one the loosening check understands", () => {
    for (const r of REAL.rules) expect(sampleName(r.pattern), r.name).toMatch(/\.js$/);
  });

  it("rejects an exception without a date or a task, a duplicate name, a bad pattern", () => {
    const p = validateBudgets(spec([{ name: "a", pattern: "^a-", budgetKb: 1, task: "W1" }, { name: "a", pattern: "(", budgetKb: 0 }]));
    expect(p).toEqual(["rules[0] (a): an exception needs expires as YYYY-MM-DD", "rules[1] (a): the name is used twice", "rules[1] (a): pattern is not a regular expression", "rules[1] (a): budgetKb must be a positive number"]);
  });
});

describe("exceptions expire", () => {
  it("an exception fails the day after its date, not on it", () => {
    const s = spec(base());
    expect(expiredExceptions(s, "2027-01-15")).toEqual([]);
    expect(expiredExceptions(s, "2027-01-16")).toEqual([{ name: "vendor: excalidraw core", expires: "2027-01-15", task: "W1.36", budgetKb: 740 }]);
  });

  it("today is UTC, and LUMEN_TODAY overrides it", () => {
    expect(today({}, new Date("2026-11-12T23:30:00Z"))).toBe("2026-11-12");
    expect(today({ LUMEN_TODAY: "2027-02-01" })).toBe("2027-02-01");
    expect(today({ LUMEN_TODAY: "soon" }, new Date("2026-11-12T00:00:00Z"))).toBe("2026-11-12");
  });
});

describe("the ratchet", () => {
  it("measured + 2 %, at least + 1 KB, up to the next whole KB", () => {
    expect(withMargin(177.9)).toBe(182); // 177.9 × 1.02 = 181.46
    expect(withMargin(0.3)).toBe(2); // + 1 KB floor
    expect(withMargin(718.6)).toBe(733);
    expect(withMargin(98)).toBe(100);
  });

  it("lowers each budget to measured + margin when that is lower, never raises one, and logs it", () => {
    const s = spec(base());
    const sizes = { totalKb: 0, classes: { "main bundle": { kb: 178, files: 1, maxKb: 177.9 }, "vendor: excalidraw core": { kb: 718.6, files: 1, maxKb: 718.6 }, "lazy plugin chunk": { kb: 900, files: 30, maxKb: 99.6 }, "startup total": { kb: 455.1, files: 60 } } };
    const r = ratchet(s, measuredFromSizes(sizes), { date: "2026-11-19", train: "train-3" });
    expect(r.changes).toEqual([
      { name: "main bundle", before: 195, after: 182, measured: 177.9 },
      { name: "vendor: excalidraw core", before: 740, after: 733, measured: 718.6 },
    ]);
    // 99.6 + 2 % = 102 > 100 and 455.1 + 2 % = 465 > 460: unchanged, not raised.
    expect(r.budgets.rules.find((x: Rule) => x.name === "lazy plugin chunk").budgetKb).toBe(100);
    expect(r.budgets.startup.budgetKb).toBe(460);
    expect(r.unmeasured).toEqual(["vendor: excalidraw", "vendor: other", "lazy: ts checker"]);
    expect(r.budgets.rules.find((x: Rule) => x.name === "vendor: excalidraw core").expires).toBe("2027-01-15");
    expect(r.budgets.history).toEqual([{ date: "2026-11-19", train: "train-3", lowered: ["main bundle 195 → 182", "vendor: excalidraw core 740 → 733"] }]);
    // What the ratchet writes never fails its own loosening check.
    expect(budgetRaises(s, r.budgets)).toEqual([]);
    // A second run on the same numbers changes nothing.
    expect(ratchet(r.budgets, measuredFromSizes(sizes)).changes).toEqual([]);
  });

  it("lowers the startup budget too", () => {
    const r = ratchet(spec(base()), { startupKb: 300, rules: {} });
    expect(r.changes).toEqual([{ name: "startup total", before: 460, after: 306, measured: 300 }]);
  });

  it("reads the receipt from a build log and the first-party measure from its log line", () => {
    const rec = { totalKb: 1, classes: { "main bundle": { kb: 1, files: 1, maxKb: 1 } } };
    expect(sizesFromLog(`▶ budget\n  ✓ main bundle …\nbundle-sizes: ${JSON.stringify(rec)}\n✓ All chunks within budget.`)).toEqual(rec);
    expect(() => sizesFromLog("✓ All chunks within budget.")).toThrow(/no `bundle-sizes:` line/);
    expect(parseFirstParty("startup first-party: 218.0 KB gz, 41 chunks, 900 inputs, 30 external packages")).toBe(218);
    expect(parseFirstParty("nothing")).toBeNull();
  });
});

describe("what counts as a raise", () => {
  it("nothing changed, or everything went down: no raise", () => {
    expect(budgetRaises(spec(base()), spec(base()))).toEqual([]);
    const lower = base().map((r) => ({ ...r, budgetKb: r.budgetKb - 1 }));
    expect(budgetRaises(spec(base()), spec(lower, 459))).toEqual([]);
  });

  it("a raised number, a raised startup, a wider margin", () => {
    const up = base().map((r) => (r.name === "main bundle" ? { ...r, budgetKb: 200 } : r));
    const after = { ...spec(up, 470), margin: { pct: 5, minKb: 1 } };
    expect(budgetRaises(spec(base()), after)).toEqual([
      { what: "startup total", before: 460, after: 470, why: "raised" },
      { what: "ratchet margin", before: "2% / 1 KB", after: "5% / 1 KB", why: "a wider margin" },
      { what: "main bundle", before: 195, after: 200, why: "raised" },
    ]);
  });

  it("a new rule wider than the one its files fell under is a raise; a narrower one is not", () => {
    const add = (r: Rule) => {
      const rules = base();
      rules.splice(rules.length - 1, 0, r);
      return spec(rules);
    };
    expect(budgetRaises(spec(base()), add({ name: "lazy: big", pattern: "^big-", budgetKb: 150 }))).toEqual([{ what: "big-Ab12Cd34.js (lazy plugin chunk → lazy: big)", before: 100, after: 150, why: "falls to a bigger rule" }]);
    expect(budgetRaises(spec(base()), add({ name: "lazy: small", pattern: "^small-", budgetKb: 40 }))).toEqual([]);
  });

  it("removing the exception is fine when its files fall to a smaller rule (W1.36 done)", () => {
    const done = base().filter((r) => r.name !== "vendor: excalidraw core");
    expect(budgetRaises(spec(base()), spec(done))).toEqual([]);
    // Moving a narrow rule first changes no chunk's budget; a wide rule first that gives more is a raise.
    const reordered = [base()[4], ...base().filter((_, i) => i !== 4)];
    expect(budgetRaises(spec(base()), spec(reordered))).toEqual([]);
    const greedy = [{ name: "lazy: everything", pattern: "\\.js$", budgetKb: 100 }, ...base()];
    expect(budgetRaises(spec(base()), spec(greedy))).toEqual([]); // 100 everywhere is lower or equal…
    const greedyBig = [{ name: "lazy: everything", pattern: "\\.js$", budgetKb: 300 }, ...base().slice(0, -1)];
    expect(budgetRaises(spec(base()), spec(greedyBig)).map((x: { what: string }) => x.what)).toContain("app-Ab12Cd34.js (main bundle → lazy: everything)");
  });

  it("an exception's date moved later, or dropped, is a raise", () => {
    const later = base().map((r) => (r.expires ? { ...r, expires: "2027-06-01" } : r));
    expect(budgetRaises(spec(base()), spec(later))).toEqual([{ what: "vendor: excalidraw core", before: "2027-01-15", after: "2027-06-01", why: "an exception's expiry moved later" }]);
    const forever = base().map((r) => (r.expires ? { name: r.name, pattern: r.pattern, budgetKb: r.budgetKb } : r));
    expect(budgetRaises(spec(base()), spec(forever))).toEqual([{ what: "vendor: excalidraw core", before: "2027-01-15", after: "no date", why: "an exception lost its expiry date" }]);
  });

  it("a pattern the check can't read is refused", () => {
    const odd = [...base().slice(0, -1), { name: "lazy: odd", pattern: "^(a|b)-", budgetKb: 10 }, base().at(-1)!];
    expect(budgetRaises(spec(base()), spec(odd))).toEqual([{ what: "lazy: odd", before: null, after: 10, why: "pattern ^(a|b)- is not a plain prefix: the check can't tell what it covers" }]);
  });
});

describe("FCP and LCP in the same ratchet (plan 8.3)", () => {
  const cfg = () => ({ runs: 5, profiles: { desktop: { assert: { fcp: { error: 1200, target: 1000 }, lcp: { error: 3500, target: 2500 }, tbt: { warn: 250 } } }, mobile: { assert: { fcp: { warn: 3000 }, lcp: { warn: 6000 } } } } });

  it("lowers the error and warn limits to the median run + 2 % (at least 50 ms), never the target", () => {
    const report = { profiles: [{ name: "desktop", median: { fcp: 1300, lcp: 2000, tbt: 10 } }, { name: "mobile", median: { fcp: 2000, lcp: null } }] };
    const r = ratchetPerf(cfg(), report);
    expect(r.changes).toEqual([
      { name: "desktop lcp error", before: 3500, after: 2050, measured: 2000 },
      { name: "mobile fcp warn", before: 3000, after: 2050, measured: 2000 },
    ]);
    expect(r.config.profiles.desktop.assert.fcp).toEqual({ error: 1200, target: 1000 }); // FCP is red: 1300 > 1200, unchanged
    expect(r.config.profiles.desktop.assert.lcp).toEqual({ error: 2050, target: 2500 });
    expect(r.config.profiles.desktop.assert.tbt).toEqual({ warn: 250 });
    expect(perfRaises(cfg(), r.config)).toEqual([]);
  });

  it("a raised, removed or downgraded perf limit, or fewer runs, is a raise", () => {
    const after = cfg();
    after.runs = 3;
    after.profiles.desktop.assert.fcp = { error: 1300, target: 1000 };
    (after.profiles.desktop.assert as Record<string, unknown>).lcp = { warn: 3500 };
    delete (after.profiles.mobile.assert as Record<string, unknown>).lcp;
    expect(perfRaises(cfg(), after)).toEqual([
      { what: "desktop fcp error", before: 1200, after: 1300, why: "raised" },
      { what: "desktop lcp error", before: 3500, after: "warn 3500", why: "an error limit became a warning" },
      { what: "mobile lcp warn", before: 6000, after: "none", why: "the limit was removed" },
      { what: "runs", before: 5, after: 3, why: "fewer runs per profile" },
    ]);
  });

  it("Lighthouse: a level lowered, a maxNumericValue raised, a minScore lowered, an assertion removed", () => {
    const lh = (a: Record<string, unknown>) => ({ ci: { assert: { assertions: a } } });
    const before = lh({ "categories:performance": ["error", { minScore: 0.65 }], "first-contentful-paint": ["error", { maxNumericValue: 1000 }], "total-blocking-time": ["warn", { maxNumericValue: 250 }], "uses-rel-preconnect": "off" });
    expect(lighthouseRaises(before, before)).toEqual([]);
    const after = lh({ "categories:performance": ["error", { minScore: 0.6 }], "first-contentful-paint": ["warn", { maxNumericValue: 1200 }] });
    expect(lighthouseRaises(before, after)).toEqual([
      { what: "categories:performance", before: 0.65, after: 0.6, why: "minScore lowered" },
      { what: "first-contentful-paint", before: "error", after: "warn", why: "a lower level" },
      { what: "first-contentful-paint", before: 1000, after: 1200, why: "maxNumericValue raised" },
      { what: "total-blocking-time", before: "warn", after: "none", why: "the assertion was removed" },
    ]);
  });
});

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "lumen-ratchet-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.org");
  git("config", "user.name", "T");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const commit = (rules: Rule[], msg: string, startup = 460) => {
    writeFileSync(join(dir, "scripts/bundle-budgets.json"), JSON.stringify(spec(rules, startup), null, 2) + "\n");
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD").trim();
  };
  return { dir, git, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("npm run budget:history and budget:ratchet", () => {
  it("history: 0 raises when the file only went down; names the commit that raised one", () => {
    const g = gitRepo();
    try {
      g.commit(base(), "chore: budgets [skip ci]");
      g.commit(base().map((r) => (r.name === "main bundle" ? { ...r, budgetKb: 182 } : r)), "chore: ratchet [skip ci]", 455);
      const lines: string[] = [];
      expect(run(parseArgs(["--history", "--cwd", g.dir]), (l: string) => lines.push(l))).toBe(0);
      expect(lines).toEqual(["budget history since the first commit:", "✓ budget history: 2 commits of scripts/bundle-budgets.json, perf-gate.config.json, lighthouserc.json, 0 raises."]);
      const bad = g.commit(base(), "feat: more room [skip ci]", 455);
      const h = checkHistory(g.dir);
      expect(h.raises).toEqual([{ sha: bad, subject: "feat: more room [skip ci]", path: "scripts/bundle-budgets.json", line: "- `scripts/bundle-budgets.json` main bundle: 182 → 195 (raised)." }]);
      expect(run(parseArgs(["--history", "--cwd", g.dir]), () => {})).toBe(1);
    } finally {
      g.done();
    }
  });

  it("history starts where the ratchet began: an older raise of a perf limit is outside it unless --since all", () => {
    const g = gitRepo();
    try {
      const perf = (fcp: number) => {
        writeFileSync(join(g.dir, "perf-gate.config.json"), JSON.stringify({ runs: 5, profiles: { desktop: { assert: { fcp: { error: fcp } } } } }));
        g.git("add", "-A");
        g.git("commit", "-q", "-m", `perf ${fcp}`);
      };
      perf(1000);
      perf(1200); // before the ratchet: an owner decision of its day
      g.commit(base(), "chore: budgets [skip ci]");
      expect(run(parseArgs(["--history", "--cwd", g.dir]), () => {})).toBe(0);
      const all = checkHistory(g.dir, "all");
      expect(all.raises.map((x: { line: string }) => x.line)).toEqual(["- `perf-gate.config.json` desktop fcp error: 1000 → 1200 (raised)."]);
    } finally {
      g.done();
    }
  });

  it("ratchet: a dry run writes nothing; --write lowers the file and records the train", () => {
    const g = gitRepo();
    try {
      g.commit(base(), "chore: budgets [skip ci]");
      const file = join(g.dir, "scripts/bundle-budgets.json");
      const before = readFileSync(file, "utf8");
      writeFileSync(join(g.dir, "sizes.json"), JSON.stringify({ totalKb: 1, classes: { "main bundle": { kb: 150, files: 1, maxKb: 150 }, "startup total": { kb: 400, files: 50 } } }));
      writeFileSync(join(g.dir, "startup.log"), "startup first-party: 218.0 KB gz, 4 chunks\n");
      const lines: string[] = [];
      run(parseArgs(["--cwd", g.dir, "--sizes", "sizes.json", "--first-party", "startup.log", "--train", "train-3", "--sha", "abc", "--date", "2026-11-19"]), (l: string) => lines.push(l));
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(lines.join("\n")).toContain("↓ main bundle: 195 → 153 KB (measured 150 KB)");
      expect(lines.join("\n")).toContain("↓ startup total: 460 → 408 KB (measured 400 KB)");
      expect(lines.join("\n")).toContain("2 limits would go down: rerun with --write.");
      run(parseArgs(["--cwd", g.dir, "--sizes", "sizes.json", "--first-party", "startup.log", "--train", "train-3", "--sha", "abc", "--date", "2026-11-19", "--write"]), () => {});
      const after = JSON.parse(readFileSync(file, "utf8"));
      expect(after.startup.budgetKb).toBe(408);
      expect(after.history).toEqual([{ date: "2026-11-19", train: "train-3", sha: "abc", startupKb: 400, firstPartyKb: 218, lowered: ["main bundle 195 → 153", "startup total 460 → 408"] }]);
      g.git("add", "-A");
      g.git("commit", "-q", "-m", "chore: ratchet [skip ci]");
      expect(checkHistory(g.dir).raises).toEqual([]);
    } finally {
      g.done();
    }
  });
});

describe("the real bundle-budget.mjs", () => {
  function dist() {
    const dir = mkdtempSync(join(tmpdir(), "lumen-budget-"));
    mkdirSync(join(dir, "scripts/lib"), { recursive: true });
    for (const f of ["scripts/bundle-budget.mjs", "scripts/bundle-budgets.json", "scripts/lib/budgetRatchet.mjs", "scripts/lib/sourcemaps.mjs"]) cpSync(join(ROOT, f), join(dir, f));
    mkdirSync(join(dir, "dist/assets"), { recursive: true });
    // Incompressible text, so the gzipped size is a few KB, not a few bytes.
    writeFileSync(join(dir, "dist/assets/app-abc123.js"), randomBytes(6000).toString("base64"));
    writeFileSync(join(dir, "dist/assets/lazy-a1.js"), "y".repeat(3000));
    writeFileSync(join(dir, "dist/index.html"), '<script type="module" src="/assets/app-abc123.js"></script>');
    return dir;
  }
  const budget = (dir: string, env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ["scripts/bundle-budget.mjs", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });

  it("passes before the exception's date, prints the receipt, and writes maxKb per class", () => {
    const dir = dist();
    try {
      const r = budget(dir, { LUMEN_TODAY: "2026-11-12" }, "--json", "reports/bundle-sizes.json");
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("⏳ exception vendor: excalidraw core 740 KB until 2027-01-15 (task W1.36)");
      const sizes = JSON.parse(readFileSync(join(dir, "reports/bundle-sizes.json"), "utf8"));
      expect(Object.keys(sizes.classes).sort()).toEqual(["lazy plugin chunk", "main bundle", "startup total"]);
      expect(sizes.classes["main bundle"].maxKb).toBeGreaterThan(5);
      expect(sizes.classes["main bundle"].maxKb).toBeLessThan(195);
      expect(sizesFromLog(r.stdout)).toEqual(sizes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails once the exception has expired, naming its task", () => {
    const dir = dist();
    try {
      const r = budget(dir, { LUMEN_TODAY: "2027-01-16" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('exception "vendor: excalidraw core" (740 KB) expired on 2027-01-15: finish W1.36, or decide it again with a new date');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
