/**
 * retrieval/heq: answerable HeQ test questions as queries over the 238
 * paragraphs of the HeQ test split, one query per paragraph. The relevant
 * document is the paragraph the question was written for; the other
 * paragraphs of the same article are listed as `sameArticle` (unjudged).
 * The split's seed picks both the paragraphs and their question.
 */
import { shuffle, splitPoolWith } from "../../lib/golden.mjs";
import { pad } from "../common.mjs";
import { fetchText, rawUrl, sha256 } from "../fetch.mjs";
import { SRC } from "../defs.mjs";

const PATH = "data/data v1.1/test v1.1.json";
const usable = (q) => !q.is_impossible && q.answers?.length && !["deixis", "second"].includes(q["question quality"]);

export const heq = {
  pool(ctx) {
    const s = SRC.heq;
    const text = fetchText(ctx.cache, rawUrl(s.repo, s.commit, PATH), { name: "heq-test-v1.1.json" });
    const corpus = [];
    const paragraphs = [];
    JSON.parse(text).data.forEach((article, a) => {
      for (const p of article.paragraphs) {
        const id = `heq-d${pad(corpus.length + 1)}`;
        corpus.push({ id, title: article.title, origin: article.source, text: p.context });
        paragraphs.push({ id, article: a, origin: article.source, qas: p.qas.filter(usable) });
      }
    });
    for (const p of paragraphs) p.sameArticle = paragraphs.filter((o) => o.article === p.article && o.id !== p.id).map((o) => o.id);
    return { items: paragraphs.filter((p) => p.qas.length), corpus, provenance: { repo: `https://github.com/${s.repo}`, commit: s.commit, files: { [PATH]: sha256(text) } } };
  },
  select: (pool, opts) =>
    splitPoolWith(pool.items, opts, (p, seed) => {
      const q = shuffle(p.qas, `${seed}:question:${p.id}`, (x) => x.id)[0];
      return { id: `heq-q-${p.id.slice(5)}`, query: q.question, relevant: [p.id], sameArticle: p.sameArticle, answers: [...new Set(q.answers.map((x) => x.text))], origin: p.origin, heqId: q.id };
    }),
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: every HeQ v1.1 test paragraph with an answerable question (not deixis / second person); paragraphs and their question drawn by splitPoolWith with the split's seed" },
    fields: { query: "HeQ question", relevant: "ids of the relevant corpus documents (gain 1)", sameArticle: "other paragraphs of the same article (unjudged)", answers: "the HeQ answer spans", origin: "Wikipedia | Geektime", corpus: "every paragraph of the HeQ v1.1 test split (Wikipedia ones are CC BY-SA at their origin)" },
  }),
  extra: (pool) => ({ corpus: pool.corpus }),
};
