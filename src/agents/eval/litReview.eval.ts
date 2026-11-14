/**
 * Plan W5.12 — the literature-review matrix against a real local model.
 * Not part of the normal test run: `npm run eval:lit-review` (it sets
 * LUMEN_EVAL_LIT=1).
 *
 *   LUMEN_EVAL_OLLAMA_URL   default http://localhost:11434
 *   LUMEN_EVAL_MODEL        default qwen2.5:7b (must be pulled)
 *   LUMEN_EVAL_LIT_FILES    comma-separated JSON files of { papers: [{ id, title, pages, gold }] };
 *                           default: the dev probe eval/probes/lit-review.json. The acceptance
 *                           set is 20 real papers with the same shape (owner).
 *   LUMEN_EVAL_OUT          report directory, default eval/results
 *
 * Targets (plan): ≥ 85 % of fields right, every citation on the right page,
 * no value without a citation.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { buildIndex, retrieve } from "../../pdf/pdfChat";
import type { PdfPageText } from "../../pdf/pdfChatCore";
import { extractPaper } from "../../research/litReviewCore";
import { runAgentOrThrow } from "../runtime";
import { litExtractorAgent } from "../defs";
// @ts-expect-error the harness is plain JavaScript
import { scoreLitReview } from "../../../scripts/research/score-lit-review.mjs";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";
const files = (process.env.LUMEN_EVAL_LIT_FILES || "eval/probes/lit-review.json").split(",").map((s: string) => s.trim()).filter(Boolean);
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";

describe.skipIf(!process.env.LUMEN_EVAL_LIT)(`literature review eval — ${model} @ ${url}`, () => {
  it("extracts every field of every paper and writes the report", async () => {
    // privacy-ledger: local-ai — the eval's own Ollama on this machine (LUMEN_EVAL_OLLAMA_URL), not app code.
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch((e: Error) => e);
    expect(tags instanceof Error ? `Ollama unreachable at ${url}: ${tags.message}` : "ok").toBe("ok");
    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");
    const rows = [];
    for (const file of files) {
      const set = JSON.parse(readFileSync(file, "utf8")) as { papers: Array<{ id: string; title: string; pages: PdfPageText[]; gold: Record<string, { page: number; phrase: string }> }> };
      const results = [];
      for (const p of set.papers) {
        const index = await buildIndex(`papers/${p.id}.pdf`, "", p.pages, null);
        const r = await extractPaper(`papers/${p.id}.pdf`, p.title, (q) => retrieve(index, q, 4), (field, chunks) => runAgentOrThrow(litExtractorAgent, { text: field.ask, extra: { title: p.title, field: field.key, chunks } }, { document: p.title }));
        results.push({ id: p.id, ...r });
      }
      const s = scoreLitReview(results, set.papers);
      rows.push({ file, ...s });
      // hygiene-allow: progress output of a CLI eval run
      console.log(`${file}: ${s.papers} papers — fields right ${(s.fieldAccuracy * 100).toFixed(1)} %, values without a citation ${s.uncited}; wrong: ${s.wrong.join(", ") || "none"}`);
      expect(s.uncited).toBe(0);
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `lit-review-${new Date().toISOString().slice(0, 10)}-${model.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify({ model, url, rows }, null, 2) + "\n");
  }, 60 * 60 * 1000);
});
