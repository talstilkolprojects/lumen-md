/**
 * Plan 6.8 / owner item 15.17 — chat with a PDF against a real local model:
 * the share of answers whose citation is right. Not part of the normal test
 * run; start it with `npm run eval:pdf-chat` (it sets LUMEN_EVAL_PDF=1).
 *
 *   LUMEN_EVAL_OLLAMA_URL   default http://localhost:11434
 *   LUMEN_EVAL_MODEL        default qwen2.5:7b (must be pulled)
 *   LUMEN_EVAL_PDF_DIRS     comma-separated split folders holding docs.json
 *                           (default: the committed dev split; add the test
 *                           split built with the golden seed for all 30)
 *   LUMEN_EVAL_OUT          report directory, default eval/results
 *
 * An answer counts as correctly cited when it is not empty and at least one
 * of its verified citations is on a page whose text contains the golden
 * answer (or an accepted alternative). The plan's target is ≥ 85 %.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
vi.mock("../../ai/ocr", () => ({ ocrImage: vi.fn(async () => ({ text: "", confidence: 0, lang: "en" })) }));
vi.mock("../../pdf/pdfjs", () => ({
  openPdf: async (data: Uint8Array) => {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument(o: { data: Uint8Array; isEvalSupported: boolean }): { promise: Promise<unknown>; destroy(): Promise<void> };
    };
    pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
    const task = pdfjs.getDocument({ data, isEvalSupported: false });
    return { doc: await task.promise, close: () => task.destroy() };
  },
}));

import { answerFrom, buildIndex, pdfPages } from "../../pdf/pdfChat";
import type { PdfPageText } from "../../pdf/pdfChatCore";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";
const dirs = (process.env.LUMEN_EVAL_PDF_DIRS || "eval/golden/pdf-qa/dev").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";
const squash = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

interface Item {
  id: string;
  doc: string;
  file: string;
  question: string;
  answer: string;
  alt: string[];
}

// skip-reason: an opt-in eval against a real local model (npm run eval:pdf-chat), not a unit test | task: 7.3 | until: 2027-05-12
describe.skipIf(!process.env.LUMEN_EVAL_PDF)(`pdf chat eval — ${model} @ ${url}`, () => {
  it("answers every question and writes the report", async () => {
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch((e: Error) => e);
    expect(tags instanceof Error ? `Ollama unreachable at ${url}: ${tags.message}` : "ok").toBe("ok");
    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");

    const rows: Array<{ id: string; ok: boolean; answer: string; pages: number[]; answerPages: number[]; ms: number; error?: string }> = [];
    for (const dir of dirs) {
      const set = JSON.parse(readFileSync(join(dir, "docs.json"), "utf8")) as { items: Item[] };
      const pagesOf = new Map<string, PdfPageText[]>();
      for (const item of set.items) {
        if (!pagesOf.has(item.file)) pagesOf.set(item.file, await pdfPages(new Uint8Array(readFileSync(join(dir, item.file)))));
        const pages = pagesOf.get(item.file)!;
        const want = [item.answer, ...item.alt].map(squash);
        const answerPages = pages.filter((p) => want.some((a) => squash(p.text).includes(a))).map((p) => p.page);
        const index = await buildIndex(item.file, "", pages, null);
        const t0 = Date.now();
        try {
          const res = await answerFrom(index, item.question);
          const cited = res.citations.map((c) => c.page);
          const ok = !res.notFound && cited.some((p) => answerPages.includes(p));
          rows.push({ id: item.id, ok, answer: res.answer, pages: cited, answerPages, ms: Date.now() - t0 });
        } catch (e) {
          rows.push({ id: item.id, ok: false, answer: "", pages: [], answerPages, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        }
        const r = rows[rows.length - 1];
        // hygiene-allow: progress output of a CLI eval run
        console.log(`${r.ok ? "pass" : "FAIL"}  ${r.id}  ${(r.ms / 1000).toFixed(1)} s  cited ${r.pages.join(",") || "-"} / answer on ${r.answerPages.join(",") || "?"}  ${r.error ?? ""}`);
      }
    }
    const passed = rows.filter((r) => r.ok).length;
    const share = rows.length ? passed / rows.length : 0;
    const date = new Date().toISOString().slice(0, 10);
    const slug = model.replace(/[^\w.-]+/g, "_");
    mkdirSync(outDir, { recursive: true });
    const md = [`# PDF chat eval — ${model}, ${date}`, "", `Correctly cited: **${passed} / ${rows.length} (${(share * 100).toFixed(1)} %)** — target ≥ 85 % (plan 6.8).`, "", "| id | ok | cited pages | answer on pages | s |", "|---|---|---|---|---|", ...rows.map((r) => `| ${r.id} | ${r.ok ? "✓" : "✗"} | ${r.pages.join(", ")} | ${r.answerPages.join(", ")} | ${(r.ms / 1000).toFixed(1)} |`)].join("\n");
    writeFileSync(join(outDir, `pdf-chat-${date}-${slug}.md`), md + "\n");
    writeFileSync(join(outDir, `pdf-chat-${date}-${slug}.json`), JSON.stringify({ model, url, date, passed, total: rows.length, rows }, null, 2));
    // hygiene-allow: tells the person running the eval where the report is
    console.log(`\nCorrectly cited ${passed}/${rows.length} (${(share * 100).toFixed(1)} %). Report: ${join(outDir, `pdf-chat-${date}-${slug}.md`)}`);
  }, 60 * 60 * 1000);
});
