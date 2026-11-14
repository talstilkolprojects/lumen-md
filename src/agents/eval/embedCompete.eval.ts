/**
 * Plan W7.13 — the Hebrew embeddings / reranker competition on real models
 * (transformers.js 4, in Node; WebGPU numbers come from the app). Needs the
 * hard set (node scripts/golden/build-retrieval-hard.mjs) and the models
 * from Hugging Face, after gate 0.10 has verified each one's licence and
 * files (eval/models/embedding-candidates.json). Start it with
 * `npm run eval:embed-compete` (it sets LUMEN_EVAL_EMBED=1).
 *
 *   LUMEN_EVAL_EMBED_MODELS   comma-separated candidate ids (default: every embedding candidate)
 *   LUMEN_EVAL_OUT            report directory, default eval/results
 *
 * Writes the table (nDCG@10, Recall@20, ms per query, download and index
 * size, Matryoshka 256) and the decisions: does the set discriminate
 * (≥ 5 points), which model is the default (≥ 5 held-out points and
 * ≤ 150 ms per query at 10,000 notes), is the reranker on (≥ 3 points).
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error the harness is plain JavaScript
import { chooseDefault, discriminates, evaluateCandidate } from "../../../scripts/golden/evals/embed-compete.mjs";

interface Candidate {
  id: string;
  kind: "embedding" | "reranker";
  hf: string;
  dims?: number;
  matryoshka?: number[];
  prefix?: { query: string; document: string };
  dtype?: string;
  licenseVerified: boolean;
}
const manifest = JSON.parse(readFileSync("eval/models/embedding-candidates.json", "utf8")) as { current: string; candidates: Candidate[] };
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";
const wanted = (process.env.LUMEN_EVAL_EMBED_MODELS || "").split(",").filter(Boolean);
const load = (f: string) => JSON.parse(readFileSync(join("eval/golden/retrieval-hard", f), "utf8")) as { items: never[]; corpus: Array<{ id: string; title?: string; text: string }> };

// skip-reason: an opt-in eval that downloads real models (npm run eval:embed-compete), not a unit test | task: W7.13 | until: 2027-05-14
describe.skipIf(!process.env.LUMEN_EVAL_EMBED)("Hebrew embeddings competition (W7.13)", () => {
  it("measures every candidate on dev and held-out and records the decisions", async () => {
    expect(existsSync("eval/golden/retrieval-hard/dev.json") ? "ok" : "run node scripts/golden/build-retrieval-hard.mjs first").toBe("ok");
    const { pipeline } = await import("@huggingface/transformers");
    const dev = load("dev.json");
    const held = load("heldout.json");
    const rows: Array<Record<string, unknown>> = [];
    type Row = { id: string; ndcg10: number; recall20: number; msPerQuery: number; dims: number; indexBytes: number; items: number };
    const heldRows: Row[] = [];
    const devRows: Row[] = [];
    for (const c of manifest.candidates.filter((x) => x.kind === "embedding" && (!wanted.length || wanted.includes(x.id)))) {
      expect(c.licenseVerified || process.env.LUMEN_EVAL_EMBED_UNVERIFIED === "1" ? "ok" : `${c.id}: licence not verified at gate 0.10`).toBe("ok");
      const extractor = await pipeline("feature-extraction", c.hf, { dtype: (c.dtype ?? "q8") as "q8" });
      const embed = async (texts: string[], kind: "query" | "document") => {
        const pre = kind === "query" ? (c.prefix?.query ?? "") : (c.prefix?.document ?? "");
        const out = await extractor(texts.map((t) => pre + t), { pooling: "mean", normalize: true });
        return out.tolist() as number[][];
      };
      for (const dims of [undefined, ...(c.matryoshka?.includes(256) ? [256] : [])]) {
        const cand = { id: dims ? `${c.id}@${dims}` : c.id, embed, ...(dims ? { matryoshka: dims } : {}) };
        const d: Row = await evaluateCandidate(cand, dev);
        const h: Row = await evaluateCandidate(cand, held);
        devRows.push(d);
        heldRows.push(h);
        rows.push({ id: cand.id, dev: d, heldout: h });
      }
    }
    const decision = {
      discriminates: discriminates(devRows),
      default: chooseDefault(heldRows, manifest.current, { notes: held.corpus.length }),
      reranker: null as null | { on: boolean; gain: number },
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `embed-compete-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ rows, decision }, null, 2) + "\n");
    expect(decision.discriminates, "the hard set must separate the candidates by ≥ 5 nDCG@10 points").toBe(true);
  }, 6 * 3_600_000);
});
