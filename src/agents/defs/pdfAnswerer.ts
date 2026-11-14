/**
 * pdf-answerer (plan 6.8) — answers a question about one PDF from the
 * numbered passages retrieval found, citing each claim with a quote copied
 * from a passage. The quotes are checked here: a citation counts only when
 * its quote is in the passage it names (or covers ≥ 85 % of it, the
 * research `quoteCoverage` rule), so each one can be shown on its page and
 * line. An answer without one verified citation is sent back once.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { fail, ok } from "./shared";
import { locateQuote, sourcesBlock, type PdfAnswerOut, type PdfChunk } from "../../pdf/pdfChatCore";
import { quoteCoverage } from "../../research/citations";

export interface PdfAnswererInput extends AgentInput {
  /** The question. */
  text: string;
  extra: { title: string; chunks: PdfChunk[] };
}

/** A citation is verified when its quote is in the passage it names. */
export function citationVerified(c: { source: number; quote: string }, chunks: readonly PdfChunk[]): boolean {
  const chunk = chunks[c.source - 1];
  if (!chunk || typeof c.quote !== "string" || !c.quote.trim()) return false;
  return locateQuote(c.quote, chunk) !== null || quoteCoverage(c.quote, chunk.text) >= 0.85;
}

export const pdfAnswererAgent: AgentDefinition<PdfAnswererInput, PdfAnswerOut> = registerAgent<PdfAnswererInput, PdfAnswerOut>({
  id: "pdf-answerer",
  commandId: "pdf.ask",
  description: "Answer a question about a PDF with quotes from its pages",
  system: (input) =>
    `You answer questions about the PDF "${input.extra.title}" using ONLY the numbered passages below. ` +
    "Answer in the language of the question, briefly. Support the answer with citations: for each, the passage " +
    "number and a short quote copied EXACTLY (word for word) from that passage. " +
    'Output ONLY JSON: {"answer": "...", "citations": [{"source": 1, "quote": "exact words from passage 1"}]}. ' +
    'If the passages do not contain the answer, output {"answer": "", "citations": []}.\n\n' +
    sourcesBlock(input.extra.chunks),
  user: (input) => input.text,
  outputSchema: {
    type: "object",
    properties: {
      answer: { type: "string" },
      citations: {
        type: "array",
        maxItems: 8,
        items: { type: "object", properties: { source: { type: "integer", minimum: 1 }, quote: { type: "string", minLength: 1 } }, required: ["source", "quote"] },
      },
    },
    required: ["answer", "citations"],
  },
  validators: [
    {
      name: "quotes",
      check: (out, input) => {
        const chunks = (input as PdfAnswererInput).extra.chunks;
        if (!out.answer.trim()) return ok;
        return out.citations.some((c) => citationVerified(c, chunks))
          ? ok
          : fail("no citation quotes its passage word for word", "Copy each quote exactly from the passage you cite, and give its number.");
      },
    },
  ],
  // The question's language decides; the quotes are in the PDF's.
  language: "any",
  maxRetries: 1,
  tier: "small",
  temperature: 0,
  maxTokens: 700,
});
