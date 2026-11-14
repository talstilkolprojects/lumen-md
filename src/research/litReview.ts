/**
 * Plan W5.12 — the app side of the literature review: every PDF in the
 * vault (or the ones given), read on this device (6.8's index: text, OCR
 * for scanned pages, BM25 + local embeddings), each field extracted by the
 * local model with verified quotes, and written as one note per paper plus
 * `Literature review.base`. Nothing is sent anywhere unless the AI policy
 * the user chose allows a cloud model.
 */
import { extractPaper, FIELDS, noteName, paperNote, reviewBase, type NoteWords, type PaperResult } from "./litReviewCore";
import { t } from "../i18n";
import "./litReviewStrings";

function words(): NoteWords & { verified: string; all: string; verifiedOnly: string } {
  return {
    labels: { question: t("litReview.field.question"), method: t("litReview.field.method"), sample: t("litReview.field.sample"), findings: t("litReview.field.findings"), limitations: t("litReview.field.limitations") },
    source: t("litReview.source"),
    noValue: t("litReview.noValue"),
    page: (page, line) => t("litReview.pageLine", { page, line }),
    verified: t("litReview.verifiedFields"),
    all: t("litReview.view.all"),
    verifiedOnly: t("litReview.view.verifiedOnly"),
  };
}

export const REVIEW_FOLDER = "Literature review";

export interface LitReviewProgress {
  done: number;
  total: number;
  current: string;
}

export async function buildLiteratureReview(opts: { pdfs?: string[]; folder?: string; signal?: AbortSignal; onProgress?: (p: LitReviewProgress) => void } = {}): Promise<{ papers: PaperResult[]; written: string[] }> {
  const folder = opts.folder ?? REVIEW_FOLDER;
  const [{ listWorkspace, writeWorkspaceFile }, { indexPdf, retrieve }, { runAgentOrThrow }, { litExtractorAgent }] = await Promise.all([
    import("../storage/workspace"),
    import("../pdf/pdfChat"),
    import("../agents/runtime"),
    import("../agents/defs"),
  ]);
  const pdfs = opts.pdfs ?? (await listWorkspace({ includeAssets: true })).map((e) => e.path).filter((p) => /\.pdf$/i.test(p)).sort();
  const papers: PaperResult[] = [];
  const written: string[] = [];
  for (const [i, pdf] of pdfs.entries()) {
    opts.signal?.throwIfAborted();
    const title = (pdf.split("/").pop() ?? pdf).replace(/\.pdf$/i, "");
    opts.onProgress?.({ done: i, total: pdfs.length, current: title });
    const index = await indexPdf(pdf, { signal: opts.signal });
    const paper = await extractPaper(
      pdf,
      title,
      (query) => retrieve(index, query, 4),
      (field, chunks) => runAgentOrThrow(litExtractorAgent, { text: field.ask, extra: { title, field: field.key, chunks } }, { signal: opts.signal, document: title }),
      FIELDS,
    );
    papers.push(paper);
    const path = `${folder}/${noteName(title)}.md`;
    await writeWorkspaceFile(path, paperNote(paper, { words: words() }));
    written.push(path);
  }
  const base = `${folder}/Literature review.base`;
  await writeWorkspaceFile(base, reviewBase(folder, words()));
  written.push(base);
  opts.onProgress?.({ done: pdfs.length, total: pdfs.length, current: "" });
  return { papers, written };
}
