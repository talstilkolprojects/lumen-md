/**
 * Plan 7.6 — the model reranker (bge-reranker-v2-m3) measured on the
 * retrieval golden set: nDCG@10 of BM25 alone against BM25 + the model over
 * the same 20 candidates, and the plan's decision from the gain. Not part of
 * the normal test run; start it with `npm run eval:rerank` (it sets
 * LUMEN_EVAL_RERANK=1). The first run downloads the model (~570 MB, q8) from
 * Hugging Face into the transformers.js cache.
 *
 *   LUMEN_EVAL_RERANK_DIRS   comma-separated split folders with heq.json (and
 *                            belebele.json when built — the cross-lingual part,
 *                            plan 15.9); default: the committed dev split
 *   LUMEN_EVAL_OUT           report directory, default eval/results
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Bm25Index } from "../../search/bm25";
import { RERANK_MODEL } from "../../ai/transformersEngine";
// @ts-expect-error the harness is plain JavaScript
import { compareRerank, rerankDecision } from "../../../scripts/golden/evals/rerank.mjs";

const dirs = (process.env.LUMEN_EVAL_RERANK_DIRS || "eval/golden/retrieval/dev").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";

type Doc = { id: string; text: string };

// skip-reason: an opt-in eval against a real reranker model (npm run eval:rerank), not a unit test | task: 7.3 | until: 2027-05-12
describe.skipIf(!process.env.LUMEN_EVAL_RERANK)(`reranker eval — ${RERANK_MODEL}`, () => {
  it("measures BM25 against BM25 + the model and writes the decision", async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
    const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" } as never);
    const modelRerank = async (query: string, docs: Doc[]): Promise<Doc[]> => {
      const scores: number[] = [];
      for (let i = 0; i < docs.length; i += 8) {
        const batch = docs.slice(i, i + 8).map((d) => d.text.slice(0, 2000));
        const inputs = tokenizer(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true, max_length: 512 } as never);
        const { logits } = (await model(inputs)) as { logits: { sigmoid(): { tolist(): number[][] } } };
        for (const row of logits.sigmoid().tolist()) scores.push(row[0] ?? 0);
      }
      return docs.map((d, i) => ({ d, s: scores[i] ?? 0, i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.d);
    };

    const rows: Array<{ split: string; part: string; items: number; bm25: number; reranked: number; gain: number }> = [];
    for (const dir of dirs) {
      for (const part of ["heq", "belebele"]) {
        const file = join(dir, `${part}.json`);
        if (!existsSync(file)) continue;
        const set = JSON.parse(readFileSync(file, "utf8")) as { items: Array<{ query: string; relevant: string[]; sameArticle?: string[] }>; corpus: Array<{ id: string; title?: string; text: string }> };
        const res = await compareRerank(Bm25Index, modelRerank, { items: set.items, documents: set.corpus, candidates: 20 });
        rows.push({ split: dir, part, ...res });
        // hygiene-allow: progress output of a CLI eval run
        console.log(`${dir} ${part}: ${res.items} queries — BM25 ${res.bm25}, + reranker ${res.reranked}, gain ${res.gain} points`);
      }
    }
    expect(rows.length).toBeGreaterThan(0);
    const n = rows.reduce((a, r) => a + r.items, 0);
    const gain = rows.reduce((a, r) => a + r.gain * r.items, 0) / n;
    const decision = rerankDecision(gain);
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(outDir, { recursive: true });
    const md = [
      `# Reranker eval — ${RERANK_MODEL}, ${date}`,
      "",
      `Gain over BM25 (nDCG@10, weighted by queries): **${gain.toFixed(2)} points** → decision: **${decision}** (plan 7.6: < 5 points → off by default or removed).`,
      "",
      "| split | part | queries | BM25 | + reranker | gain (points) |",
      "|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.split} | ${r.part} | ${r.items} | ${r.bm25} | ${r.reranked} | ${r.gain} |`),
    ].join("\n");
    writeFileSync(join(outDir, `rerank-${date}.md`), md + "\n");
    writeFileSync(join(outDir, `rerank-${date}.json`), JSON.stringify({ model: RERANK_MODEL, date, gain, decision, rows }, null, 2));
    // hygiene-allow: tells the person running the eval where the report is
    console.log(`\nGain ${gain.toFixed(2)} points → ${decision}. Report: ${join(outDir, `rerank-${date}.md`)}`);
  }, 60 * 60 * 1000);
});
