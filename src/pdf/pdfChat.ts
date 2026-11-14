/**
 * Plan 6.8 — ask a PDF, on this device. Lazy: loaded when the reader's
 * "Ask" panel is first used.
 *
 *   1. text from pdf.js, page by page; a page without a text layer (a scan)
 *      is rendered and read by the on-device OCR (Tesseract, T31);
 *   2. chunks of lines with their page and line numbers, indexed with BM25
 *      and — when an Ollama on this machine has an embedding model — with
 *      embeddings too, fused by reciprocal rank;
 *   3. the `pdf-answerer` agent through the runtime (local first, traced)
 *      answers from the best passages with quotes; each quote is located on
 *      its page and line, and only verified ones are shown.
 */
import { bm25Index, bm25Search, chunkPages, cosine, fuse, locateQuote, type Bm25Index, type LocatedCitation, type PdfChunk, type PdfPageText } from "./pdfChatCore";
import { pageTextFromItems } from "./textMap";
import { log } from "../lib/logger";

/** A page with less text than this is treated as scanned. */
const MIN_PAGE_TEXT = 20;
/** Passages the answerer reads. */
const TOP_K = 6;

export interface PdfIndex {
  path: string;
  /** size + modified time of the file it was built from. */
  stamp: string;
  pages: PdfPageText[];
  chunks: PdfChunk[];
  bm25: Bm25Index;
  /** One vector per chunk, when an embedding model was available. */
  vectors: Float32Array[] | null;
  embedder: ((texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>) | null;
}

export interface PdfIndexProgress {
  page: number;
  pages: number;
  /** This page is being read by OCR. */
  ocr: boolean;
}

const indexes = new Map<string, PdfIndex>();

/** OCR of one rendered page (a scan). Empty when OCR is unavailable here. */
async function ocrPage(page: { getViewport(o: { scale: number }): { width: number; height: number; scale: number }; render(o: { canvas: HTMLCanvasElement; viewport: { width: number; height: number; scale: number } }): { promise: Promise<void> } }): Promise<string> {
  if (typeof document === "undefined") return "";
  try {
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const { ocrImage } = await import("../ai/ocr");
    return (await ocrImage(canvas)).text;
  } catch (e) {
    log.warn("pdf chat: OCR of a scanned page failed", e);
    return "";
  }
}

/** The text of every page: the text layer, or OCR for a page without one. */
export async function pdfPages(data: Uint8Array, opts: { signal?: AbortSignal; onProgress?: (p: PdfIndexProgress) => void } = {}): Promise<PdfPageText[]> {
  const { openPdf } = await import("./pdfjs");
  const { doc, close } = await openPdf(data);
  try {
    const out: PdfPageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await doc.getPage(n);
      let text = pageTextFromItems((await page.getTextContent()).items);
      let ocr = false;
      if (text.replace(/\s+/g, "").length < MIN_PAGE_TEXT) {
        opts.onProgress?.({ page: n, pages: doc.numPages, ocr: true });
        const read = await ocrPage(page);
        if (read.trim()) {
          text = read;
          ocr = true;
        }
      } else opts.onProgress?.({ page: n, pages: doc.numPages, ocr: false });
      out.push({ page: n, text, ocr });
      page.cleanup();
    }
    return out;
  } finally {
    await close().catch(() => undefined);
  }
}

/** Embeddings from an Ollama on this machine, or null (BM25 alone then; no model download on this path). */
async function localEmbedder(): Promise<PdfIndex["embedder"]> {
  try {
    const { pickEmbeddingProvider } = await import("../ai/embeddingProvider");
    const provider = await pickEmbeddingProvider();
    if (!provider.id.startsWith("ollama:")) return null;
    return (texts, kind) => provider.embed(texts, kind);
  } catch {
    return null;
  }
}

/** Build (or reuse) the index of a PDF in the vault. */
export async function indexPdf(path: string, opts: { signal?: AbortSignal; onProgress?: (p: PdfIndexProgress) => void } = {}): Promise<PdfIndex> {
  const { readWorkspaceBlob } = await import("../storage/workspace");
  const blob = await readWorkspaceBlob(path);
  const stamp = `${blob.size}:${(blob as Partial<File>).lastModified ?? ""}`;
  const cached = indexes.get(path);
  if (cached && cached.stamp === stamp) return cached;
  const pages = await pdfPages(new Uint8Array(await blob.arrayBuffer()), opts);
  return buildIndex(path, stamp, pages, await localEmbedder(), opts.signal);
}

/** The index of given pages (exported for the tests and the evaluation). */
export async function buildIndex(path: string, stamp: string, pages: PdfPageText[], embedder: PdfIndex["embedder"], signal?: AbortSignal): Promise<PdfIndex> {
  const chunks = chunkPages(pages);
  let vectors: Float32Array[] | null = null;
  if (embedder && chunks.length) {
    try {
      vectors = [];
      for (let i = 0; i < chunks.length; i += 32) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        vectors.push(...(await embedder(chunks.slice(i, i + 32).map((c) => c.text), "passage")));
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      log.warn("pdf chat: embeddings failed; BM25 only", e);
      vectors = null;
    }
  }
  const index: PdfIndex = { path, stamp, pages, chunks, bm25: bm25Index(chunks.map((c) => c.text)), vectors, embedder: vectors ? embedder : null };
  indexes.set(path, index);
  return index;
}

/** The passages for a question: BM25, fused with embeddings when there are any. */
export async function retrieve(index: PdfIndex, question: string, k = TOP_K): Promise<PdfChunk[]> {
  const lexical = bm25Search(index.bm25, question, k * 2).map((r) => r.i);
  const lists: number[][] = [lexical];
  if (index.vectors && index.embedder) {
    try {
      const [q] = await index.embedder([question], "query");
      const vecs = index.vectors;
      lists.push(
        vecs
          .map((v, i) => ({ i, s: cosine(q, v) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, k * 2)
          .map((x) => x.i),
      );
    } catch (e) {
      log.warn("pdf chat: query embedding failed; BM25 only", e);
    }
  }
  const picked = lists.length > 1 ? fuse(lists, 60, k) : lexical.slice(0, k);
  // No word of the question in the PDF: the first passages, so the model can say it isn't there.
  return (picked.length ? picked : index.chunks.slice(0, k).map((c) => c.id)).map((i) => index.chunks[i]);
}

export interface PdfAnswer {
  answer: string;
  /** Verified citations, located on their page and line. */
  citations: LocatedCitation[];
  /** Citations the model gave whose quote isn't in the passage (not shown). */
  dropped: number;
  /** The PDF doesn't answer the question (the model said so). */
  notFound: boolean;
  runId?: string;
}

/** Ask the PDF at `path`. */
export async function askPdf(path: string, question: string, opts: { signal?: AbortSignal; onProgress?: (p: PdfIndexProgress) => void } = {}): Promise<PdfAnswer> {
  const index = await indexPdf(path, opts);
  return answerFrom(index, question, opts.signal);
}

/** Answer from an index (exported for the tests and the evaluation). */
export async function answerFrom(index: PdfIndex, question: string, signal?: AbortSignal): Promise<PdfAnswer> {
  const chunks = await retrieve(index, question);
  const [{ runAgentOrThrow }, { pdfAnswererAgent, citationVerified }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
  const title = index.path.split("/").pop()?.replace(/\.pdf$/i, "") ?? index.path;
  const out = await runAgentOrThrow(pdfAnswererAgent, { text: question, extra: { title, chunks } }, { signal, document: question });
  const citations: LocatedCitation[] = [];
  let dropped = 0;
  for (const c of out.citations) {
    const chunk = chunks[c.source - 1];
    if (!chunk || !citationVerified(c, chunks)) {
      dropped++;
      continue;
    }
    const at = locateQuote(c.quote, chunk) ?? { page: chunk.page, line: chunk.lineStart };
    if (!citations.some((x) => x.page === at.page && x.line === at.line && x.quote === c.quote)) citations.push({ source: c.source, quote: c.quote, ...at });
  }
  return { answer: out.answer.trim(), citations, dropped, notFound: !out.answer.trim() };
}

/** Tests. */
export function __clearPdfIndexes(): void {
  indexes.clear();
}

export interface PdfSummary {
  /** Each sentence of the summary with the page and line it was copied from. */
  sentences: Array<{ text: string; page: number | null; line: number | null }>;
  engine: string;
  model?: string;
}

/** A grounded summary of the whole PDF (plan 6.11), each sentence placed on its page and line. */
export async function summarizePdf(path: string, opts: { signal?: AbortSignal; onProgress?: (p: PdfIndexProgress) => void } = {}): Promise<PdfSummary> {
  const index = await indexPdf(path, opts);
  const { summarize } = await import("../ai/summarize");
  const res = await summarize(index.pages.map((p) => p.text).join("\n\n"), { signal: opts.signal });
  return {
    engine: res.engine,
    model: res.model,
    sentences: res.sentences.map((text) => {
      // The first piece before a "…" cut is enough to find the line.
      const head = text.split(/\.\.\.|…/)[0].trim();
      for (const c of index.chunks) {
        const at = head ? locateQuote(head, c) : null;
        if (at) return { text, page: at.page, line: at.line };
      }
      return { text, page: null, line: null };
    }),
  };
}
