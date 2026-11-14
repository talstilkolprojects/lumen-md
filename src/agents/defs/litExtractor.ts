/**
 * lit-extractor (plan W5.12) — one field of one paper for the literature
 * review matrix (question, method, sample, findings or limitations), from
 * the numbered passages retrieval found, with quotes copied from them. A
 * value counts only when one of its quotes is in the passage it names
 * (research/litReviewCore.ts verifies and locates them); an answer without
 * one is sent back once.
 */
import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { fail, ok } from "./shared";
import { sourcesBlock, type PdfChunk } from "../../pdf/pdfChatCore";
import { verifyField, type FieldOut, type LitField } from "../../research/litReviewCore";

export interface LitExtractorInput extends AgentInput {
  /** What to extract, in words ("the study design and method"). */
  text: string;
  extra: { title: string; field: LitField["key"]; chunks: PdfChunk[] };
}

export const litExtractorAgent: AgentDefinition<LitExtractorInput, FieldOut> = registerAgent<LitExtractorInput, FieldOut>({
  id: "lit-extractor",
  commandId: "research.litReview",
  description: "Extract one field of a paper for the literature review, with quotes from its pages",
  system: (input) =>
    `You extract ${input.text} of the paper "${input.extra.title}" using ONLY the numbered passages below. ` +
    "Write the value in one or two sentences, in the language of the paper. Support it with citations: for each, the passage " +
    "number and a short quote copied EXACTLY (word for word) from that passage. " +
    'Output ONLY JSON: {"value": "...", "citations": [{"source": 1, "quote": "exact words from passage 1"}]}. ' +
    'If the passages do not say it, output {"value": "", "citations": []}.\n\n' +
    sourcesBlock(input.extra.chunks),
  user: (input) => `Extract: ${input.text}`,
  outputSchema: {
    type: "object",
    properties: {
      value: { type: "string" },
      citations: {
        type: "array",
        maxItems: 4,
        items: { type: "object", properties: { source: { type: "integer", minimum: 1 }, quote: { type: "string", minLength: 1 } }, required: ["source", "quote"] },
      },
    },
    required: ["value", "citations"],
  },
  validators: [
    {
      name: "quotes",
      check: (out, input) => {
        const i = input as LitExtractorInput;
        if (!out.value.trim()) return ok;
        return verifyField(i.extra.field, out, i.extra.chunks).value
          ? ok
          : fail("no citation quotes its passage word for word", "Copy each quote exactly from the passage you cite, and give its number.");
      },
    },
  ],
  language: "any",
  maxRetries: 1,
  tier: "small",
  temperature: 0,
  maxTokens: 400,
});
