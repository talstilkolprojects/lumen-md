// @vitest-environment node
/**
 * Plan W9.3 — one owner checklist (scripts/owner-checklist.mjs): owner steps
 * pulled from PR bodies and plan.json, grouped by resource, ordered by
 * dependency, rendered to docs/owner/checklist.md, and --check.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collect,
  render,
  check,
  order,
  classify,
  findOwnerSections,
  splitSteps,
  extractCommands,
  previousState,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/owner-checklist.mjs";

type Pr = { number: number; title: string; body: string; headRefName: string };
type Step = { id: string; prs: number[]; tasks: string[]; group: string; cmds: string[]; text: string; after: string[]; late: string[]; delegated?: boolean; notes: string[]; source: string };

const ROOT = resolve(__dirname, "..", "..");
const FX = join(ROOT, "src/__tests__/fixtures/owner-checklist");
const prs: Pr[] = JSON.parse(readFileSync(join(FX, "prs.json"), "utf8"));
const plan = JSON.parse(readFileSync(join(FX, "plan.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "lumen-owner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const model = () => collect({ prs, plan }) as { steps: Step[]; ownerPrs: number[]; skipped: { number: number }[] };
const stepOf = (m: { steps: Step[] }, needle: string) => m.steps.find((s) => s.text.includes(needle) || s.cmds.some((c) => c.includes(needle)));

describe("owner-checklist: extraction from PR bodies", () => {
  it("finds every PR with owner steps and skips trains and 'None'", () => {
    const m = model();
    expect(m.ownerPrs).toEqual([101, 102, 103, 106, 107]);
    expect(m.skipped.map((s) => s.number)).toEqual([105]); // verify/* train copies other bodies
    expect(m.steps.some((s) => s.prs.includes(104))).toBe(false); // "None for this PR."
  });

  it("reads '## Owner commands', '## Owner steps (…)', '**Owner steps**', inline 'Owner:' lines and owed lists", () => {
    const m = model();
    expect(stepOf(m, "ollama pull qwen2.5:7b")).toBeTruthy(); // ## Owner commands, fenced
    expect(stepOf(m, "npm run nightly -- --kind perf")).toBeTruthy(); // ## Owner steps (second host)
    expect(stepOf(m, "npm run models:pin")).toBeTruthy(); // **Owner steps**
    expect(stepOf(m, "open the widget on an iPhone")).toBeTruthy(); // inline ⏳ Owner:
    expect(stepOf(m, "npx percy exec")).toBeTruthy(); // owner line in "Not verified here (owed)"
    expect(stepOf(m, "Vercel build: deferred")).toBeUndefined(); // owed, but not the owner's
    expect(stepOf(m, "More text")).toBeUndefined(); // the bold heading's section ended
    expect(stepOf(m, "Durable Objects")).toBeUndefined(); // decisions already made under delegation
  });

  it("keeps the exact commands, one per line", () => {
    const s = stepOf(model(), "ollama pull qwen2.5:7b")!;
    expect(s.cmds).toEqual(["npm ci", "ollama pull qwen2.5:7b", "node scripts/models-day.mjs"]);
    expect(extractCommands("Run `npx wrangler login` and look at `src/x.ts`.")).toEqual(["npx wrangler login"]);
    expect(extractCommands("`HF_TOKEN=<t> npm run models:pin`")).toEqual(["HF_TOKEN=<t> npm run models:pin"]);
  });

  it("merges the same step from stacked PRs and names both PRs and the task", () => {
    const s = stepOf(model(), "ollama pull qwen2.5:7b")!;
    expect(s.prs).toEqual([101, 106]);
    expect(s.tasks).toEqual(["W1.1"]);
  });

  it("splits a numbered list into one step per item", () => {
    const sec = findOwnerSections(prs.find((p) => p.number === 102)!.body)[0];
    expect(splitSteps(sec)).toHaveLength(3);
  });

  it("adds plan.json owner statuses: as a note on the PR's step, or as a step of its own", () => {
    const m = model();
    expect(stepOf(m, "open the widget on an iPhone")!.notes.join(" ")).toContain("(בעלים)");
    const own = m.steps.find((s) => s.source === "plan")!;
    expect(own.tasks).toEqual(["W1.6"]);
    expect(own.text).toContain("הזנת התאריכים");
    expect(m.steps.find((s) => s.source === "owner")!.tasks).toEqual(["15.7"]);
  });
});

describe("owner-checklist: groups and order", () => {
  it("groups each step by the resource it needs", () => {
    const m = model();
    const g = (needle: string) => stepOf(m, needle)!.group;
    expect(g("ollama pull")).toBe("mac");
    expect(g("npm run nightly")).toBe("secondHost");
    expect(g("wrangler@4 deploy")).toBe("cloudflare");
    expect(g("VITE_SHARE_URL")).toBe("vercel");
    expect(g("npx percy exec")).toBe("accounts");
    expect(g("models:pin")).toBe("models");
    expect(g("iPhone")).toBe("devices");
    expect(g("Recruit 5 testers")).toBe("people");
    expect(g("License: keep CC BY-SA")).toBe("legal");
    expect(m.steps.find((s) => s.tasks.includes("15.7"))!.group).toBe("accounts");
  });

  it("an explicit place beats a keyword", () => {
    expect(classify("On the second host: `npx wrangler deploy`").group).toBe("secondHost");
    expect(classify("On the Mac: `npm run mobile:ios` then TestFlight on the iPhone").group).toBe("mac");
    expect(classify("Something with no resource").group).toBe("other");
  });

  it("marks delegated review leftovers (Codex threads) in the decisions group", () => {
    const s = stepOf(model(), "Codex P2")!;
    expect(s.group).toBe("legal");
    expect(s.delegated).toBe(true);
  });

  it("orders by dependency: PR references and plan deps, flagging a dependency in a later session", () => {
    const m = model();
    const sessions = order(m.steps, plan) as { group: string; steps: Step[] }[];
    expect(sessions.map((s) => s.group)).toEqual(["accounts", "legal", "people", "models", "cloudflare", "vercel", "secondHost", "mac", "devices", "other"]);
    const mac = stepOf(m, "ollama pull")!;
    expect(mac.after).toEqual(["4.1"]); // W1.1 depends on W1.5 (the HF pin)
    const recruit = stepOf(m, "Recruit 5 testers")!;
    expect(recruit.late).toEqual(["8.1"]); // it names #101, whose step is in the Mac session
    const calendar = m.steps.find((s) => s.tasks.includes("W1.6"))!;
    expect(calendar.after).toEqual(expect.arrayContaining(["5.1", "6.1"])); // W1.6 depends on W1.2
  });
});

describe("owner-checklist: the page, re-runs and --check", () => {
  it("renders Hebrew first with an English section, commands, sources and what each step unblocks", () => {
    const md = render(model(), plan, { generated: "T" }) as string;
    expect(md).toMatch(/^<!-- Generated by `npm run owner:checklist`/);
    expect(md).toContain('<div dir="rtl">');
    expect(md).toContain("# רשימת הבעלים");
    expect(md).toContain("## English");
    expect(md).toContain("## ישיבה 8 — Mac (1)");
    expect(md).toContain("  ollama pull qwen2.5:7b");
    expect(md).toContain("[#101](https://github.com/talstilkol/lumen-md/pull/101), [#106]");
    expect(md).toMatch(/משחרר: אימות W1\.2 \(שרת שיתוף חי\); ואחריו W1\.6, W1\.7/);
  });

  it("never writes the taken domain, even when a PR body quotes it", () => {
    const taken = ["lumen", "md"].join("."); // built here so this file never spells it
    const quoting = { number: 130, title: "y (W1.4)", headRefName: "y", body: `## Owner commands\n- Owner: check that \`curl -sI https://${taken}/\` is not ours; the app is lumen-md.vercel.app.` };
    const md = render(collect({ prs: [quoting], plan }), plan, { generated: "T" }) as string;
    expect(md.includes(taken)).toBe(false);
    expect(md).toContain("(the taken domain)");
    expect(md).toContain("lumen-md.vercel.app");
  });

  it("a re-run keeps ticked boxes and reports steps that went away", () => {
    const m = model();
    const first = render(m, plan, { generated: "T" }) as string;
    const mac = stepOf(m, "ollama pull")!;
    const ticked = first.replace(`- [ ] **8.1**`, `- [x] **8.1**`);
    expect(previousState(ticked).done.has(mac.id)).toBe(true);
    const second = render(m, plan, { previous: ticked + "\n- [ ] gone <!-- id:0123456789 prs:999 -->", generated: "T" }) as string;
    expect(second).toContain(`- [x] **8.1**`);
    expect(second).toContain("1 סומנו כבוצעו");
    expect(second).toContain("1 צעדים ירדו מאז הריצה הקודמת");
  });

  it("--check passes on a fresh page and names the PR whose owner section is missing", () => {
    const m = model();
    const md = render(m, plan, { generated: "T" }) as string;
    expect(check(m, md).ok).toBe(true);
    const without103 = md
      .split("\n")
      .filter((l) => !/prs:103 -->/.test(l))
      .join("\n");
    const r = check(m, without103);
    expect(r.ok).toBe(false);
    expect(r.missingPrs).toEqual([103]);
    // A new owner section in an open PR makes the old page stale.
    const grown = collect({ prs: [...prs, { number: 120, title: "x (W1.4)", headRefName: "x", body: "## Owner commands\n- `npm run something`" }], plan });
    expect(check(grown, md).missingPrs).toEqual([120]);
  });

  it("the CLI writes the page offline and --check exits 1 when it is stale", () => {
    const out = join(tmp, "checklist.md");
    const script = join(ROOT, "scripts/owner-checklist.mjs");
    const base = ["--prs", join(FX, "prs.json"), "--plan", join(FX, "plan.json"), "--out", out];
    execFileSync(process.execPath, [script, ...base, "--date", "T"], { cwd: ROOT });
    expect(readFileSync(out, "utf8")).toContain("## English");
    execFileSync(process.execPath, [script, ...base, "--check"], { cwd: ROOT }); // exits 0
    writeFileSync(out, readFileSync(out, "utf8").replace(/^.*prs:102 -->.*$/gm, ""));
    let code = 0;
    try {
      execFileSync(process.execPath, [script, ...base, "--check"], { cwd: ROOT, stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
  });
});
