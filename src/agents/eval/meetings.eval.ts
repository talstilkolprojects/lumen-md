/**
 * Plan 6.16 / owner item 15.11 — meeting notes against a real local model
 * on the owner's golden meetings (7.10 `meetings`, never committed): the
 * share of the reference action items the notes found. Start it with
 * `npm run eval:meetings` (it sets LUMEN_EVAL_MEETINGS=1).
 *
 *   LUMEN_EVAL_MEETINGS_DIR  the bundle folder meetings/owner/ with
 *                            <id>.transcript.txt and <id>.summary.md
 *                            (its action items: `- [ ]` lines, or the bullets
 *                            under a heading with "action", "task" or "משימ")
 *   LUMEN_EVAL_OLLAMA_URL    default http://localhost:11434
 *   LUMEN_EVAL_MODEL         default qwen2.5:7b
 *   LUMEN_EVAL_OUT           report directory, default eval/results
 *
 * The transcript is the reference one, so this measures the notes, not the
 * speech recognition (that is 6.1's WER). Target: ≥ 90 % of the tasks found.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { meetingNotesFrom } from "../../meetings/meetingNotes";
import { taskRecall } from "../../meetings/meetingCore";

const dir = process.env.LUMEN_EVAL_MEETINGS_DIR || "";
const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";

/** The reference action items of a summary.md. */
export function referenceTasks(md: string): string[] {
  const boxes = [...md.matchAll(/^\s*[-*] \[[ xX]\] (.+)$/gm)].map((m) => m[1].trim());
  if (boxes.length) return boxes;
  const out: string[] = [];
  let inTasks = false;
  for (const line of md.split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      inTasks = /action|task|todo|משימ/i.test(h[1]);
      continue;
    }
    const b = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (inTasks && b) out.push(b[1].trim());
  }
  return out;
}

describe.skipIf(!process.env.LUMEN_EVAL_MEETINGS)(`meeting notes eval — ${model} @ ${url}`, () => {
  it("finds the action items of every golden meeting and writes the report", async () => {
    expect(dir ? "ok" : "set LUMEN_EVAL_MEETINGS_DIR to the bundle's meetings/owner folder").toBe("ok");
    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");
    const ids = readdirSync(dir).filter((f) => f.endsWith(".transcript.txt")).map((f) => f.replace(/\.transcript\.txt$/, ""));
    expect(ids.length).toBeGreaterThan(0);
    const rows: Array<{ id: string; reference: number; found: number; predicted: number }> = [];
    for (const id of ids) {
      const transcript = readFileSync(join(dir, `${id}.transcript.txt`), "utf8");
      const ref = referenceTasks(readFileSync(join(dir, `${id}.summary.md`), "utf8"));
      const res = await meetingNotesFrom(transcript, { local: true });
      const predicted = res.notes.tasks.map((t) => t.text);
      const found = Math.round(taskRecall(predicted, ref) * ref.length);
      rows.push({ id, reference: ref.length, found, predicted: predicted.length });
      // hygiene-allow: progress output of a CLI eval run
      console.log(`${id}: ${found}/${ref.length} tasks found (${predicted.length} proposed)`);
    }
    const ref = rows.reduce((a, r) => a + r.reference, 0);
    const found = rows.reduce((a, r) => a + r.found, 0);
    const share = ref ? found / ref : 1;
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(outDir, { recursive: true });
    const md = [`# Meeting notes eval — ${model}, ${date}`, "", `Tasks found: **${found} / ${ref} (${(share * 100).toFixed(1)} %)** — target ≥ 90 % (plan 6.16).`, "", "| meeting | reference tasks | found | proposed |", "|---|---|---|---|", ...rows.map((r) => `| ${r.id} | ${r.reference} | ${r.found} | ${r.predicted} |`)].join("\n");
    writeFileSync(join(outDir, `meetings-${date}.md`), md + "\n");
    // hygiene-allow: tells the person running the eval where the report is
    console.log(`\nTasks found ${found}/${ref} (${(share * 100).toFixed(1)} %). Report: ${join(outDir, `meetings-${date}.md`)}`);
  }, 60 * 60 * 1000);
});
