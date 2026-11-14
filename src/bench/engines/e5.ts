/** Dense retrieval with the app's embedding model (multilingual-e5-small): cosine over the whole corpus, e5's query/passage prefixes. */
import { EMBEDDING_MODEL, embedTextsLocal, transformersDevice } from "../../ai/transformersEngine";
import type { RetrievalDoc, RetrievalInput } from "../retrieval";
import type { BenchEngine } from "../types";

const parts = new Map<string, { ids: string[]; vectors: number[][] }>();

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) out.push(...(await embedTextsLocal(texts.slice(i, i + 16))).vectors);
  return out;
}

export const engine: BenchEngine = {
  id: "e5",
  label: "multilingual-e5-small, dense",
  set: "retrieval",
  models: [EMBEDDING_MODEL],
  async load() {
    await embedTextsLocal(["query: טעינה"]);
    return { device: await transformersDevice(), model: EMBEDDING_MODEL };
  },
  async prepare(part, shared) {
    const docs = shared as RetrievalDoc[];
    parts.set(part, { ids: docs.map((d) => d.id), vectors: await embed(docs.map((d) => `passage: ${d.title ? `${d.title}. ` : ""}${d.text}`.slice(0, 2000))) });
  },
  async run(item) {
    const p = parts.get(item.part)!;
    const input = item.input as RetrievalInput;
    const skip = new Set(input.skip);
    const [q] = await embed([`query: ${input.query}`]);
    return p.ids
      .map((id, i) => ({ id, s: cosine(q, p.vectors[i]) }))
      .filter((x) => !skip.has(x.id))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.id);
  },
  dispose: async () => parts.clear(),
};
