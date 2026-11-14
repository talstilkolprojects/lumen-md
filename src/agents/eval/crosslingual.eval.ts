/**
 * Plan W5.28 — cross-language search measured with the real model: Hebrew
 * questions over English passages, nDCG@10 of BM25 alone (with W2.11's
 * Hebrew→English lexicon), of multilingual-e5-small alone, and of the two
 * fused (what Smart search does). Not part of the normal test run:
 * `npm run eval:crosslingual` (it sets LUMEN_EVAL_XL=1). The first run
 * downloads the model (~120 MB, q8) from Hugging Face.
 *
 *   LUMEN_EVAL_XL_FILES  comma-separated JSON files of { items, corpus };
 *                        default: the dev probe eval/probes/crosslingual-he-en.json.
 *                        The held-out check is a Belebele heb_Hebr → eng_Latn split
 *                        built locally (docs: workspace/search, "Cross-language").
 *   LUMEN_EVAL_OUT       report directory, default eval/results
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Bm25Index } from "../../search/bm25";
import { EMBEDDING_MODEL } from "../../ai/transformersEngine";
import { fuse, rankByCosine } from "../../search/crossLingual";
// @ts-expect-error the harness is plain JavaScript
import { scoreCrossLingual, TARGET_NDCG } from "../../../scripts/search/crosslingual-eval.mjs";

const files = (process.env.LUMEN_EVAL_XL_FILES || "eval/probes/crosslingual-he-en.json").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";

// skip-reason: an opt-in eval against a real local model (LUMEN_EVAL_XL=1), not a unit test | task: W5.28 | until: 2027-05-12
describe.skipIf(!process.env.LUMEN_EVAL_XL)(`cross-language eval — ${EMBEDDING_MODEL}`, () => {
  it("measures BM25, e5 and the fusion on Hebrew questions over English passages", async () => {
    const { pipeline } = await import("@huggingface/transformers");
    const extract = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" } as never);
    const embed = async (texts: string[]): Promise<Float32Array[]> => {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const t = (await extract(texts.slice(i, i + 16), { pooling: "mean", normalize: true } as never)) as unknown as { tolist(): number[][] };
        for (const row of t.tolist()) out.push(Float32Array.from(row));
      }
      return out;
    };
    const rows: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const set = JSON.parse(readFileSync(file, "utf8")) as { items: Array<{ id: string; query: string; relevant: string[] }>; corpus: Array<{ id: string; title?: string; text: string }> };
      const index = new Bm25Index();
      for (const d of set.corpus) index.set(d.id, d.text, d.title ?? "");
      const vectors = await embed(set.corpus.map((d) => `passage: ${d.text}`));
      const docs = set.corpus.map((d, i) => ({ id: d.id, vector: vectors[i] }));
      const bm25 = (q: string) => index.search(q, { limit: 20 }).map((h) => h.id);
      const dense = async (q: string) => rankByCosine((await embed([`query: ${q}`]))[0], docs, 20).map((h) => h.id);
      const fused = async (q: string) => fuse([{ ids: bm25(q) }, { ids: await dense(q), weight: 1.2 }], 10);
      const t0 = performance.now();
      const r = {
        file: basename(file),
        bm25: (await scoreCrossLingual(bm25, set)).ndcg10,
        dense: (await scoreCrossLingual(dense, set)).ndcg10,
        fused: (await scoreCrossLingual(fused, set)).ndcg10,
        ms: Math.round(performance.now() - t0),
      };
      rows.push(r);
      // hygiene-allow: progress output of a CLI eval run
      console.log(`${r.file}: ${set.items.length} questions — BM25 ${r.bm25}, e5 ${r.dense}, fused ${r.fused} (target ${TARGET_NDCG})`);
    }
    expect(rows.length).toBeGreaterThan(0);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `crosslingual-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ model: EMBEDDING_MODEL, target: TARGET_NDCG, rows }, null, 2) + "\n");
  });
});
