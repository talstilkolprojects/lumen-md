/**
 * Plan W2.1 — the vault organizer: suggestions (links, tags, merges, maps
 * of content) with confidence, explanation and quote; staged for review,
 * never written; learning from approvals and rejections.
 *
 * The golden vault (200 notes, Hebrew and English) is generated here with
 * its true links known, including traps: generic one-word titles
 * ("Notes", "סיכום") used as ordinary words. Precision of the suggested
 * links against it stands in for the plan's human rating (≥ 80%), which
 * needs a real vault (owner step).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { analyzeVault, findMention, linkTargets, titleOf, type OrganizerNote } from "../agents/organizer/analyze";
import { applyLearning, rate, recordDecision, __resetLearning, type Book } from "../agents/organizer/learning";
import { startOrganizer, setOrganizerModel, ORGANIZER_AGENT, type OrganizerSource } from "../agents/organizer/job";
import { clearStagedChanges, listStagedChanges, rejectStagedChange } from "../agents/staging";

const TOPICS = [
  "Project Aurora", "Budget 2026", "Kubernetes Migration", "Quarterly Review", "Hiring Plan", "Design System", "Customer Interviews", "Data Retention Policy",
  "Onboarding Guide", "Release Checklist", "Pricing Experiment", "Security Audit", "Mobile Roadmap", "Search Ranking", "Offline Sync", "Accessibility Plan",
  "Marketing Calendar", "Vendor Contracts", "Team Offsite", "Incident Postmortem",
  "פרויקט אלפא", "תקציב שנתי", "תוכנית גיוס", "סקר לקוחות", "מדיניות פרטיות", "מפת דרכים", "ישיבת צוות", "תחקיר תקלה", "הדרכת עובדים", "ניסוי מחירים",
  "שיפור חיפוש", "סנכרון מקומי", "נגישות האתר", "לוח שיווק", "חוזי ספקים", "יום גיבוש", "בדיקת אבטחה", "גרסה חדשה", "ראיונות משתמשים", "תכנון רבעוני",
];
const TRAPS = ["Notes", "Ideas", "סיכום", "רעיונות"];

/** 200 notes: 40 topics, 4 generic traps, 156 notes that mention 1–3 topics and use the trap words. */
function goldenVault(): { notes: OrganizerNote[]; expected: Set<string> } {
  const notes: OrganizerNote[] = [];
  const expected = new Set<string>();
  const slug = (t: string) => t.replace(/\s+/g, "-");
  TOPICS.forEach((t, i) => notes.push({ path: `topics/${slug(t)}.md`, text: `---\ntags: [${i < 20 ? "work" : "עבודה"}]\n---\n# ${t}\n\nThe main note for ${t}.\n` }));
  for (const t of TRAPS) notes.push({ path: `misc/${t}.md`, text: `# ${t}\n\nA scratch page.\n` });
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; notes.length < 200; i++) {
    const he = i % 2 === 1;
    const pool = TOPICS.slice(he ? 20 : 0, he ? 40 : 20);
    const picks = [...new Set([pool[Math.floor(rnd() * 20)], pool[Math.floor(rnd() * 20)], pool[Math.floor(rnd() * 20)]].slice(0, 1 + (i % 3)))];
    const path = `log/${he ? "יומן" : "log"}-${i}.md`;
    const body = he
      ? picks.map((p, k) => `${k % 2 ? "ב" : ""}${p} עלה בפגישה היום. כתבתי סיכום קצר ורעיונות להמשך.`).join("\n\n")
      : picks.map((p) => `We discussed ${p} today. My notes and ideas are below.`).join("\n\n");
    notes.push({ path, text: `# ${he ? "יומן" : "Log"} ${i}\n\n${body}\n` });
    for (const p of picks) expected.add(`${path}→topics/${slug(p)}.md`);
  }
  return { notes, expected };
}

beforeEach(() => {
  clearStagedChanges();
  __resetLearning();
});
afterEach(() => {
  setOrganizerModel(null);
  clearStagedChanges();
});

describe("analysis", () => {
  it("golden vault (200 notes): ≥ 80% of suggested links are right, the traps are not linked", () => {
    const { notes, expected } = goldenVault();
    expect(notes).toHaveLength(200);
    const links = analyzeVault(notes).filter((s) => s.kind === "link");
    const pairs = links.map((s) => s.id.slice("link:".length));
    const right = pairs.filter((p) => expected.has(p)).length;
    const precision = right / pairs.length;
    const recall = right / expected.size;
    console.info(`[W2.1] golden vault: ${pairs.length} links suggested, precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}%`);
    expect(precision).toBeGreaterThanOrEqual(0.8);
    expect(recall).toBeGreaterThanOrEqual(0.6);
    expect(pairs.some((p) => /misc\//.test(p))).toBe(false);
  });

  it("a link suggestion is a range edit with a quote, an explanation and a confidence; Hebrew prefix letters are kept outside the link", () => {
    const notes = [
      { path: "a.md", text: "# A\n\nבפרויקט אלפא יש בעיה. ראו גם `פרויקט אלפא` בקוד.\n" },
      { path: "פרויקט-אלפא.md", text: "# פרויקט אלפא\n\nהפרויקט.\n" },
    ];
    const [s] = analyzeVault(notes).filter((x) => x.kind === "link");
    expect(s.reason).toEqual({ key: "organizer.reason.link", params: { title: "פרויקט אלפא", note: "a" } });
    expect(s.quote.text).toBe("בפרויקט אלפא יש בעיה.");
    expect(s.confidence).toBeGreaterThanOrEqual(0.5);
    const c = s.changes[0];
    expect(c.range).toMatchObject({ before: "פרויקט אלפא", after: "[[פרויקט-אלפא|פרויקט אלפא]]" });
    expect(c.after).toContain("ב[[פרויקט-אלפא|פרויקט אלפא]] יש");
    expect(c.after).toContain("`פרויקט אלפא`"); // code untouched
  });

  it("does not link inside code, headings, existing links, or a note that already links", () => {
    const target = { path: "Project Aurora.md", text: "# Project Aurora\n" };
    const guarded = { path: "g.md", text: "# Project Aurora notes\n\n```\nProject Aurora\n```\nInline `Project Aurora` and [Project Aurora](x.md) and https://example.com/Project%20Aurora\n" };
    expect(analyzeVault([guarded, target]).filter((s) => s.kind === "link")).toEqual([]);
    expect(findMention("say Project Aurora now", "Project Aurora", [])).toEqual({ from: 4, to: 18, prefix: 0 });
    const linkedAlready = { path: "x.md", text: "Talked about Project Aurora. Also [[project aurora]] again.\n" };
    expect(linkTargets(linkedAlready.text).has("project aurora")).toBe(true);
    expect(analyzeVault([linkedAlready, target]).filter((s) => s.kind === "link")).toEqual([]);
  });

  it("suggests tags, a merge for a duplicate, and a map of content for a big unlinked tag", () => {
    const para = "Kubernetes clusters need careful upgrades across every region and every environment we run today because the control plane and the worker nodes drift apart when one of them is patched before the other one";
    const notes: OrganizerNote[] = [
      { path: "k1.md", text: `---\ntags: [infra]\n---\n# K1\n\n${para}.\n\nExtra one.\n` },
      { path: "k2.md", text: `# K2\n\n${para}.\n\nOnly in the second copy.\n` },
      { path: "infra-notes.md", text: "# Infra notes\n\nThe infra budget and infra plans.\n" },
      ...Array.from({ length: 6 }, (_, i) => ({ path: `ops/o${i}.md`, text: `---\ntags: [ops]\n---\n# Ops ${i}\n\nRunbook ${i}.\n` })),
      { path: "z.md", text: "---\ntags: [infra]\n---\n# Z\n" },
    ];
    const all = analyzeVault(notes);
    const tag = all.find((s) => s.kind === "tag" && s.changes[0].path === "infra-notes.md");
    expect(tag?.changes[0].after.startsWith("---\ntags: [infra]\n---\n\n# Infra notes")).toBe(true);
    expect(tag?.changes[0].range).toMatchObject({ from: 0, to: 0, before: "" });
    const merge = all.find((s) => s.kind === "merge");
    expect(merge?.changes.map((c) => c.path).sort()).toEqual(["k1.md", "k2.md"]);
    const pointer = merge!.changes.find((c) => /→ \[\[k[12]\]\]/.test(c.after))!;
    const kept = merge!.changes.find((c) => c !== pointer)!;
    expect(pointer.after).toContain(`→ [[${kept.path.replace(".md", "")}]]`);
    expect(kept.after).toMatch(/Extra one\.|Only in the second copy\./);
    const moc = all.find((s) => s.kind === "moc");
    expect(moc?.changes[0]).toMatchObject({ path: "maps/ops.md", before: null });
    expect(moc?.changes[0].after).toContain("- [[o0|Ops 0]]");
    for (const s of all) {
      expect(s.confidence).toBeGreaterThanOrEqual(0.5);
      expect(s.confidence).toBeLessThan(1);
      expect(s.reason.key).toMatch(/^organizer\.reason\./);
    }
  });

  it("titles come from front matter, then the first heading, then the file name", () => {
    expect(titleOf({ path: "a/b.md", text: "---\ntitle: Real\n---\n# H\n" })).toBe("Real");
    expect(titleOf({ path: "a/b.md", text: "# Heading here\n" })).toBe("Heading here");
    expect(titleOf({ path: "a/b.md", text: "text" })).toBe("b");
  });

  it("1,000 notes analyse in well under the plan's budget (deterministic part)", () => {
    const base = goldenVault().notes;
    const notes = Array.from({ length: 1000 }, (_, i) => ({ ...base[i % 200], path: base[i % 200].path.replace(/\.md$/, `-${Math.floor(i / 200)}.md`) }));
    const t0 = performance.now();
    const out = analyzeVault(notes);
    const ms = performance.now() - t0;
    console.info(`[W2.1] 1,000 notes: ${out.length} suggestions in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});

describe("learning (plan 5.6's learning critic, for the organizer)", () => {
  it("approvals raise a feature's confidence, rejections lower it and finally stop it", async () => {
    const s = analyzeVault([
      { path: "a.md", text: "Notes on Project Aurora.\n" },
      { path: "Project Aurora.md", text: "# Project Aurora\n" },
    ])[0];
    const empty: Book = {};
    expect(applyLearning([s], empty)[0].confidence).toBe(s.confidence);
    let b = await recordDecision(["link"], true);
    b = await recordDecision(["link"], true);
    expect(rate(b, "link")).toBe(0.75);
    expect(applyLearning([s], b)[0].confidence).toBeGreaterThan(s.confidence);
    for (let i = 0; i < 10; i++) b = await recordDecision(["link"], false);
    expect(applyLearning([s], b)).toEqual([]);
  });
});

describe("the job: staged for review, nothing written", () => {
  const source = (files: Record<string, string>): OrganizerSource & { writes: number } => ({
    writes: 0,
    list: async () => Object.keys(files),
    read: async (p) => files[p],
  });

  it("reads, analyses, stages a batch under the organizer agent, and writes nothing", async () => {
    const files: Record<string, string> = {
      "a.md": "# A\n\nWe met about Project Aurora and the Hiring Plan.\n",
      "Project Aurora.md": "# Project Aurora\n",
      "Hiring Plan.md": "# Hiring Plan\n",
    };
    const snapshot = JSON.stringify(files);
    const job = startOrganizer(source(files), { chunk: 1 });
    const seen: string[] = [];
    job.subscribe((s) => seen.push(s.phase));
    const end = await job.done;
    expect(end.phase).toBe("ready");
    expect(seen).toContain("reading");
    expect(end.counts.link).toBe(2);
    expect(listStagedChanges()).toEqual([]);
    expect(job.stageNext(1)).toBe(1);
    expect(job.stageNext()).toBe(1);
    expect(job.stageNext()).toBe(0);
    const staged = listStagedChanges();
    expect(staged.map((c) => [c.agentId, c.kind, c.path])).toEqual([
      [ORGANIZER_AGENT, "range", "a.md"],
      [ORGANIZER_AGENT, "range", "a.md"],
    ]);
    expect(staged[0].summary).toMatch(/^\d+% · /);
    expect(JSON.stringify(files)).toBe(snapshot);
    rejectStagedChange(staged[0].id);
    job.dispose();
  });

  it("pause holds the run between chunks; resume continues; cancel stops with nothing staged", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n${i}.md`, `# N${i}\n`]));
    const job = startOrganizer(source(files), { chunk: 5 });
    job.pause();
    await new Promise((r) => setTimeout(r, 20));
    expect(job.state.paused).toBe(true);
    expect(job.state.read).toBeLessThan(30);
    job.resume();
    expect((await job.done).phase).toBe("ready");

    const job2 = startOrganizer(source(files), { chunk: 5 });
    job2.pause();
    job2.cancel();
    expect((await job2.done).phase).toBe("cancelled");
    expect(job2.stageNext()).toBe(0);
    expect(listStagedChanges()).toEqual([]);
  });

  it("a model seam can re-score or drop suggestions", async () => {
    setOrganizerModel(async (s) => ({ confidence: s.id.includes("Hiring") ? 0.1 : 0.97 }));
    const job = startOrganizer(source({ "a.md": "Project Aurora and the Hiring Plan.\n", "Project Aurora.md": "# Project Aurora\n", "Hiring Plan.md": "# Hiring Plan\n" }));
    const end = await job.done;
    expect(end.suggestions.map((s) => [s.id, s.confidence])).toEqual([["link:a.md→Project Aurora.md", 0.97]]);
  });

  it("with consent, the local model (through the agent runtime) re-scores the suggestions, which still only wait for review (W10.C16)", async () => {
    const { registerOrganizerModel, setOrganizerModelConsent } = await import("../agents/organizer/model");
    const { registerExecutor, resetExecutors } = await import("../agents/executors");
    const { fakeExecutor, reply } = await import("./helpers/fakeExecutor");
    resetExecutors();
    localStorage.setItem("lumen.ai.cache", "off");
    // A scripted local model: it rates the Hiring Plan link low and the Aurora one high.
    const ex = fakeExecutor((req) => reply(/Suggestion: link \(link:a\.md→Hiring/.test(req.messages.map((m) => m.content).join("\n")) ? '{"confidence": 0.1}' : '{"confidence": 0.97}'));
    registerExecutor(ex);
    const files = { "a.md": "Project Aurora and the Hiring Plan.\n", "Project Aurora.md": "# Project Aurora\n", "Hiring Plan.md": "# Hiring Plan\n" };
    try {
      // No consent: nothing registered, the model is never asked.
      setOrganizerModelConsent(false);
      expect(registerOrganizerModel()).toBe(false);
      expect((await startOrganizer(source(files)).done).suggestions).toHaveLength(2);
      expect(ex.calls).toHaveLength(0);
      // Consent: every suggestion goes to the model; the low one is dropped.
      setOrganizerModelConsent(true);
      expect(registerOrganizerModel()).toBe(true);
      const job = startOrganizer(source(files));
      const end = await job.done;
      expect(ex.calls.length).toBe(2);
      expect(end.suggestions.map((x) => [x.id, x.confidence])).toEqual([["link:a.md→Project Aurora.md", 0.97]]);
      expect(job.stageNext()).toBe(1);
      expect(listStagedChanges().map((c) => [c.agentId, c.status, c.summary.slice(0, 4)])).toEqual([[ORGANIZER_AGENT, "pending", "97% "]]);
      job.dispose();
    } finally {
      setOrganizerModelConsent(false);
      setOrganizerModel(null);
      resetExecutors();
    }
  });

  it("decisions are learned in the learning critic's book (agents/outcomes.ts), not a store of their own (W10.C16)", async () => {
    __resetLearning();
    const { featureTally } = await import("../agents/outcomes");
    await recordDecision(["link", "tag:x"], true);
    await recordDecision(["link"], false);
    expect(await featureTally("organizer", "link")).toEqual({ ok: 1, fail: 1 });
    expect(await featureTally("organizer", "tag:x")).toEqual({ ok: 1, fail: 0 });
  });
});

