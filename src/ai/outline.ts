/**
 * AI-powered outline generation — inserts markdown headings based on the
 * document content. Useful for long un-structured notes.
 *
 * Prompts the LLM with the document text and expects a JSON array of
 * heading objects. Each heading is inserted at the appropriate line.
 */

import { log } from "../lib/logger";

export type { OutlineHeading } from "../agents/defs/outliner";
import type { OutlineHeading } from "../agents/defs/outliner";

/**
 * Generate outline headings for the given markdown text through the
 * `outliner` agent. Returns heading insertions sorted by line ascending;
 * an empty array for very short text or when the agent has no usable
 * answer (the failure is logged; the command shows its own message).
 */
export async function generateOutline(
  text: string,
  signal?: AbortSignal,
): Promise<OutlineHeading[]> {
  const lines = text.split("\n");
  if (lines.length < 5) {
    return [];
  }
  try {
    const { runAgentOrThrow } = await import("../agents/runtime");
    const { outlinerAgent, normalizeHeadings } = await import("../agents/defs");
    const out = await runAgentOrThrow(outlinerAgent, { text }, { document: text, signal });
    return normalizeHeadings(out.headings, text);
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Cancelled by the user", "AbortError");
    log.warn("outline generation failed", err);
    const { reportAgentFailure } = await import("../agents/suggestions");
    reportAgentFailure(err, "ai.outline");
    return [];
  }
}

/**
 * Apply headings to a document string. Returns the new document text.
 */
export function applyOutline(
  text: string,
  headings: OutlineHeading[],
): string {
  if (headings.length === 0) return text;
  const lines = text.split("\n");
  let offset = 0;
  for (const h of headings) {
    const insertIndex = h.line + offset;
    const prefix = "#".repeat(h.level) + " ";
    lines.splice(insertIndex, 0, prefix + h.title);
    offset++;
  }
  return lines.join("\n");
}
