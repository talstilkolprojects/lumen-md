/**
 * Harness for the retrieval golden set (plan 5.2, 7.1): nDCG@10 of the
 * workspace's BM25 (src/search/bm25.ts) per part.
 *
 *   score({ items, manifest, corpus }) → { "ndcg@10.heq": …, "ndcg@10.owner": …, "ndcg@10": … }
 *
 * Each part's corpus is indexed as notes (id, title as the note's name,
 * text), each item's query is searched, and the ranking is scored with
 * binary gains (`relevant`). Documents the item marks `sameArticle`
 * (other paragraphs of the same article, unjudged) are left out of its
 * ranking rather than counted as misses (a condensed list). Belebele is
 * measured by the hybrid search (7.6), not here.
 *
 * Run by scripts/golden/run-evals.mjs in CI on the test split; the dev
 * split is scored by src/__tests__/bm25Golden.test.ts.
 */

/** nDCG@k of one ranking with binary gains. */
export function ndcgAt(ranking, relevant, k = 10) {
  const rel = new Set(relevant);
  let dcg = 0;
  ranking.slice(0, k).forEach((id, i) => {
    if (rel.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(k, rel.size); i++) ideal += 1 / Math.log2(i + 2);
  return ideal ? dcg / ideal : 0;
}

/** Index a part's documents with `Index` (the Bm25Index class), rank each item's query, average nDCG@10. */
export function scorePart(Index, items, documents, { k = 10 } = {}) {
  const index = new Index();
  // A note's name is its title, or its file name (the owner's notes are { id: path, text }).
  for (const d of documents) index.set(d.id, d.text ?? "", d.title ?? String(d.id).split("/").pop().replace(/\.md$/i, ""));
  if (!items.length) return null;
  let sum = 0;
  for (const it of items) {
    const skip = new Set(it.sameArticle ?? []);
    const ranking = index
      .search(it.query, { limit: k + skip.size })
      .map((h) => h.id)
      .filter((id) => !skip.has(id));
    sum += ndcgAt(ranking, it.relevant, k);
  }
  return sum / items.length;
}

/** Scores of every BM25 part with the given index class. */
export function scoreWith(Index, { items, corpus }) {
  const out = {};
  let n = 0;
  let total = 0;
  for (const part of ["heq", "owner"]) {
    const its = items.filter((it) => it.part === part);
    const docs = corpus?.[part] ?? [];
    if (!its.length || !docs.length) continue;
    const s = scorePart(Index, its, docs);
    out[`ndcg@10.${part}`] = Math.round(s * 10000) / 10000;
    total += s * its.length;
    n += its.length;
  }
  if (n) out["ndcg@10"] = Math.round((total / n) * 10000) / 10000;
  return out;
}

/** Load the app's BM25 (TypeScript) through Vite's bundler, in memory. */
async function loadIndex() {
  const { build } = await import("vite");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("../../../src/search/bm25.ts", import.meta.url));
  const out = await build({
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "bm25" } },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  return mod.Bm25Index;
}

export async function score({ items, corpus }) {
  return scoreWith(await loadIndex(), { items, corpus });
}
