/**
 * outliner — `ai.outline`. Proposes headings for a document without any,
 * as {level, title, line} entries the editor inserts. Lines are checked
 * against the document; a heading that lands mid-sentence is rejected.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { fail, ok } from "./shared";

export interface OutlineHeading {
  level: 1 | 2 | 3 | 4;
  title: string;
  /** 0-based line index where the heading is inserted. */
  line: number;
}

export interface OutlinerInput extends AgentInput {
  text: string;
}

export interface OutlinerOutput {
  headings: OutlineHeading[];
}

/** Clamp levels/lines and keep headings that start a paragraph, sorted. */
export function normalizeHeadings(raw: unknown, text: string): OutlineHeading[] {
  if (!Array.isArray(raw)) return [];
  const lines = text.split("\n");
  const out: OutlineHeading[] = [];
  const used = new Set<number>();
  for (const h of raw) {
    if (!h || typeof h !== "object") continue;
    const r = h as Record<string, unknown>;
    const title = String(r.title ?? "").trim();
    const line = Math.min(Math.max(Math.trunc(Number(r.line) || 0), 0), Math.max(0, lines.length - 1));
    if (!title || used.has(line)) continue;
    // A heading belongs at the start of a paragraph: the previous line is blank (or it is the top).
    if (line > 0 && lines[line - 1].trim() !== "") continue;
    if (lines[line].trim() === "") continue;
    used.add(line);
    out.push({ level: Math.min(Math.max(Number(r.level) || 2, 1), 4) as 1 | 2 | 3 | 4, title, line });
    if (out.length >= 8) break;
  }
  return out.sort((a, b) => a.line - b.line);
}

export const outlinerAgent: AgentDefinition<OutlinerInput, OutlinerOutput> = registerAgent({
  id: "outliner",
  commandId: "ai.outline",
  description: "Propose a heading structure for an unstructured document",
  system:
    "You are an expert document outliner. Given markdown text with few or no headings, propose a logical heading " +
    'structure. Output ONLY a JSON object: {"headings": [{"level": 2, "title": "Heading text", "line": 0}]}. ' +
    "Use level 2 for main sections and level 3 for subsections; rarely level 1. `line` is the 0-based index of the " +
    "line where a paragraph STARTS (the previous line is blank), never the middle of a sentence. At most 8 headings. " +
    "Write titles in the document's language.",
  user: (input) => {
    const lines = input.text.split("\n");
    // Number the lines so the model can point at paragraph starts reliably.
    const numbered = lines.slice(0, 400).map((l, i) => `${i}: ${l}`).join("\n");
    return `Propose headings for this document (${lines.length} lines, shown with line numbers):\n\n${numbered.slice(0, 6000)}`;
  },
  outputSchema: {
    type: "object",
    properties: {
      headings: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: { level: { type: "integer", minimum: 1, maximum: 4 }, title: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 0 } },
          required: ["level", "title", "line"],
        },
      },
    },
    required: ["headings"],
  },
  validators: [
    {
      name: "paragraph-starts",
      check: (out, input) => (normalizeHeadings(out.headings, input.text ?? "").length ? ok : fail("no heading lands on a paragraph start", "Use line numbers of lines that follow a blank line.")),
    },
  ],
  // The whole note, when the text given is only part of it (5.3.1, 5.3.3).
  tools: pickTools("get_document", "get_headings"),
  maxSteps: 3,
  tier: "small",
  temperature: 0.2,
  maxTokens: 600,
  cache: true,
});
