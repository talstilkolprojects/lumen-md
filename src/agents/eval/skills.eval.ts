/**
 * Plan W7.1 — the six starter skills against a real local model (plan 7.3):
 * six golden cases per skill, each a small vault and a check of what the
 * skill must produce. A skill passes with ≥ 5/6. Start it with
 * `npm run eval:skills` (it sets LUMEN_EVAL_SKILLS=1).
 *
 *   LUMEN_EVAL_OLLAMA_URL   default http://localhost:11434
 *   LUMEN_EVAL_MODEL        default qwen2.5:7b (must be pulled)
 *   LUMEN_EVAL_OUT          report directory, default eval/results
 *
 * The vault is in memory (the workspace and its index are replaced for the
 * run); every change a skill makes is only staged, as in the app.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vaultFiles = new Map<string, { text: string; modified: number }>();
vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
vi.mock("../../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  listWorkspace: async () => [...vaultFiles.entries()].map(([path, f]) => ({ path, name: path.split("/").pop(), kind: "file", size: f.text.length, modified: f.modified })),
  readWorkspaceFile: async (p: string) => {
    const f = vaultFiles.get(p);
    if (!f) throw new Error(`No file ${p}`);
    return f.text;
  },
  workspaceHasFile: async (p: string) => vaultFiles.has(p),
}));
vi.mock("../../storage/workspaceIndex", () => ({
  searchWorkspace: async (q: string, o: { limit?: number; filter?: (p: string) => boolean } = {}) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return [...vaultFiles.entries()]
      .filter(([p, f]) => (!o.filter || o.filter(p)) && words.some((w) => f.text.toLowerCase().includes(w)))
      .slice(0, o.limit ?? 20)
      .map(([path, f]) => ({ path, title: path, snippet: f.text.slice(0, 120), score: 1 }));
  },
}));

import { clearStagedChanges, listStagedChanges } from "../staging";
import type { StagedChange } from "../types";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";
const DAY = 86_400_000;
const NOW = Date.now();

interface Case {
  id: string;
  files: Record<string, string | { text: string; daysAgo: number }>;
  document?: string;
  request?: string;
  check: (out: string, staged: StagedChange[]) => boolean;
}

const TOPICS = [
  ["אנרגיה סולארית", "פאנלים", "ישן: גינון"],
  ["בינה מלאכותית", "מודלים", "ישן: בישול"],
  ["היסטוריה של ירושלים", "חומות", "ישן: כדורגל"],
  ["תזונה", "חלבונים", "ישן: צילום"],
  ["מוזיקה קלאסית", "באך", "ישן: טיולים"],
  ["אקלים", "פחמן", "ישן: שחמט"],
] as const;

const links = (out: string) => [...out.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]!.replace(/\.md$/, "").split("/").pop()!);
const files = (staged: StagedChange[]) => staged.filter((c) => c.kind === "file") as Extract<StagedChange, { kind: "file" }>[];

const CASES: Record<string, Case[]> = {
  "weekly-reading": TOPICS.map(([a, b, old], i) => ({
    id: `week-${i}`,
    files: { [`clips/${a}.md`]: { text: `# ${a}\n\nקראתי על ${a} ועל ${b}.`, daysAgo: 2 }, [`clips/${b}.md`]: { text: `# ${b}\n\n${b} הם חלק מ${a}.`, daysAgo: 4 }, [`clips/${old}.md`]: { text: `# ${old}\n\nישן מאוד.`, daysAgo: 40 } },
    check: (out) => links(out).includes(a) && !links(out).includes(old) && /[֐-׿]/.test(out),
  })),
  "sort-inbox": TOPICS.map(([a, b], i) => ({
    id: `inbox-${i}`,
    files: { [`inbox/${a}.md`]: `# ${a}\n\nרעיון על ${a}.`, [`inbox/${b}.md`]: `# ${b}\n\nהערה על ${b}.`, [`projects/x.md`]: `---\ntags: [${a.split(" ")[0]}]\n---\n# x` },
    check: (_out, staged) => {
      const fm = staged.filter((c) => c.tool === "set_frontmatter" || (c.kind === "file" && c.path.startsWith("inbox/")));
      return fm.length >= 2 && fm.every((c) => (c.kind === "file" ? c.after : "").includes("tags"));
    },
  })),
  "book-breakdown": TOPICS.map(([a, b], i) => ({
    id: `book-${i}`,
    files: {},
    document: `# ספר על ${a}\n\n## פרק א: מבוא\n\n${a} הוא נושא חשוב. ${b} מופיעים בו.\n\n## פרק ב: ${b}\n\n${b} נחקרו שנים רבות.\n\n## פרק ג: סיכום\n\nלסיכום, ${a} ו${b} קשורים.\n`,
    check: (_out, staged) => {
      const f = files(staged).filter((c) => c.path.startsWith("books/"));
      return f.length >= 2 && f.every((c) => c.after.includes("::"));
    },
  })),
  "similar-notes": TOPICS.map(([a, b, old], i) => ({
    id: `similar-${i}`,
    files: { [`notes/${b}.md`]: `# ${b}\n\nעוד על ${a} ו${b}.`, [`notes/${old}.md`]: `# ${old}\n\nבלי קשר.`, "notes/open.md": `# ${a}\n\n${a} ו${b}.` },
    document: `# ${a}\n\n${a} ו${b}.`,
    request: "",
    check: (out) => links(out).includes(b) && !links(out).includes(old),
  })),
  "literature-matrix": TOPICS.map(([a, b], i) => ({
    id: `matrix-${i}`,
    files: {
      [`sources/cohen-2020.md`]: `---\nauthor: כהן\nyear: 2020\n---\n# ${a}\n\nשאלה: האם ${a} יעיל? שיטה: סקר. ממצא: כן. מגבלה: מדגם קטן.`,
      [`sources/levi-2022.md`]: `---\nauthor: לוי\nyear: 2022\n---\n# ${b}\n\nשאלה: איך ${b} משפיעים? שיטה: ניסוי. ממצא: חלקית. מגבלה: מעבדה.`,
    },
    request: "התיקייה sources/",
    check: (_out, staged) => {
      const m = files(staged).find((c) => /literature-matrix\.md$/.test(c.path));
      return !!m && (m.after.match(/\|/g)?.length ?? 0) >= 12 && m.after.includes("כהן") && m.after.includes("לוי");
    },
  })),
  "check-citations": TOPICS.map(([a, b], i) => ({
    id: `cite-${i}`,
    files: { [`sources/${a}.md`]: `# ${a}\n\n${a} משנה את העולם במהירות רבה.` },
    document: `# טיוטה\n\nכפי שנכתב ב-[[${a}]]: ״${a} משנה את העולם במהירות רבה״.\nוגם ב-[[${a}]]: ״${b} אינם חשובים כלל״.\n`,
    check: (out) => out.includes("✓") && out.includes("✗"),
  })),
};

// skip-reason: an opt-in eval against a real local model (npm run eval:skills), not a unit test | task: W7.1 | until: 2027-05-14
describe.skipIf(!process.env.LUMEN_EVAL_SKILLS)(`starter skills eval — ${model} @ ${url}`, () => {
  it("each starter skill passes ≥ 5 of its 6 golden cases", async () => {
    // privacy-ledger: local-ai — an opt-in eval (LUMEN_EVAL_SKILLS) against Ollama on this computer, never in the app.
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch((e: Error) => e);
    expect(tags instanceof Error ? `Ollama unreachable at ${url}: ${tags.message}` : "ok").toBe("ok");
    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");
    // src/agents/skills/ loads only with a dynamic import (i18nLazyEnglish.test.ts holds it).
    const { starterSkills } = await import("../skills/starters");
    const { runSkill } = await import("../skills/run");
    const report: Record<string, { passed: number; total: number; failed: string[] }> = {};
    for (const skill of starterSkills()) {
      const cases = CASES[skill.name] ?? [];
      const r = { passed: 0, total: cases.length, failed: [] as string[] };
      for (const c of cases) {
        vaultFiles.clear();
        for (const [p, f] of Object.entries(c.files)) vaultFiles.set(p, typeof f === "string" ? { text: f, modified: NOW - DAY } : { text: f.text, modified: NOW - f.daysAgo * DAY });
        clearStagedChanges();
        let ok = false;
        try {
          const run = await runSkill(skill, { text: c.request ?? "" }, { document: c.document ?? "", path: c.document ? "notes/open.md" : null });
          ok = run.status === "ok" && c.check(String(run.output ?? ""), listStagedChanges());
        } catch {
          ok = false;
        }
        if (ok) r.passed++;
        else r.failed.push(c.id);
      }
      report[skill.name] = r;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `skills-${model.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify({ model, at: new Date().toISOString(), report }, null, 2));
    for (const [name, r] of Object.entries(report)) {
      expect(r.total, name).toBe(6);
      expect(r.passed, `${name}: ${r.passed}/6 (failed: ${r.failed.join(", ")})`).toBeGreaterThanOrEqual(5);
    }
  }, 3_600_000);
});
