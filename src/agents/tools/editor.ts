/**
 * Editor tools — the open document and the selection, as the runtime
 * received them from the command (not re-read from disk, so unsaved edits
 * count). `replace_range` is the one write tool here: it stages the edit
 * for the user's approval and never touches the buffer itself.
 */

import { defineTool, optionalNumber, stageChange, ToolError } from "./define";
import { rangeContext } from "../staging";
import type { StagedReceipt } from "../types";

export const getDocumentTool = defineTool<{ maxChars?: number }, { path: string | null; content: string; truncated: boolean; chars: number }>({
  name: "get_document",
  description: "The full text of the document the user is editing (including unsaved changes).",
  parameters: { type: "object", properties: { maxChars: { type: "number", minimum: 1 } }, additionalProperties: false },
  untrusted: (_args, _result, ctx) => ctx.documentUntrusted ?? [],
  run: async (args, ctx) => {
    const content = ctx.document ?? "";
    const max = Math.max(200, optionalNumber(args, "maxChars", 24_000));
    return { path: ctx.path ?? null, content: content.slice(0, max), truncated: content.length > max, chars: content.length };
  },
});

export const getSelectionTool = defineTool<Record<string, never>, { selection: string; empty: boolean }>({
  name: "get_selection",
  description: "The text the user selected in the editor (empty when nothing is selected).",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  untrusted: (_args, _result, ctx) => ctx.documentUntrusted ?? [],
  run: async (_args, ctx) => {
    const selection = ctx.selection ?? "";
    return { selection, empty: selection.length === 0 };
  },
});

export const getHeadingsTool = defineTool<Record<string, never>, { headings: Array<{ level: number; text: string; line: number }> }>({
  name: "get_headings",
  description: "The markdown headings of the open document with their levels and line numbers.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  untrusted: (_args, _result, ctx) => ctx.documentUntrusted ?? [],
  run: async (_args, ctx) => {
    const lines = (ctx.document ?? "").split(/\r?\n/);
    const headings: Array<{ level: number; text: string; line: number }> = [];
    let inFence = false;
    lines.forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence;
      if (inFence) return;
      const m = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) headings.push({ level: m[1].length, text: m[2], line: i + 1 });
    });
    return { headings };
  },
});

/** [from, to) of lines `start`..`end` (1-based, inclusive), without the last line's line break. */
export function lineRange(text: string, start: number, end: number): { from: number; to: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  if (start < 1 || end < start || end > starts.length) throw new ToolError("bad-args", `Lines ${start}–${end} are outside the document (1–${starts.length})`);
  const from = starts[start - 1];
  let to = end < starts.length ? starts[end] - 1 : text.length;
  if (to > from && text[to - 1] === "\r") to--;
  return { from, to };
}

export const replaceRangeTool = defineTool<
  { text: string; from?: number; to?: number; startLine?: number; endLine?: number; expected?: string },
  StagedReceipt & { from: number; to: number }
>({
  name: "replace_range",
  description:
    "Propose replacing part of the open document with `text` — by character offsets [from, to) or by lines " +
    "startLine..endLine (1-based, inclusive). Pass `expected` (the text you are replacing) so a wrong range is caught. " +
    "The edit is staged for the user's approval; the document does not change until they accept it.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Replacement text (empty deletes the range)" },
      from: { type: "integer", minimum: 0 },
      to: { type: "integer", minimum: 0 },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      expected: { type: "string", description: "The current text of the range" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  scope: "write",
  run: async (args, ctx) => {
    if (ctx.document === undefined) throw new ToolError("failed", "No document is open");
    const doc = ctx.document;
    if (typeof args.text !== "string") throw new ToolError("bad-args", '"text" must be a string');
    let range: { from: number; to: number };
    if (typeof args.startLine === "number") {
      range = lineRange(doc, args.startLine, typeof args.endLine === "number" ? args.endLine : args.startLine);
    } else if (typeof args.from === "number") {
      const to = typeof args.to === "number" ? args.to : args.from;
      if (!Number.isInteger(args.from) || !Number.isInteger(to) || args.from < 0 || to < args.from || to > doc.length) {
        throw new ToolError("bad-args", `Range [${args.from}, ${to}) is outside the document (0–${doc.length})`);
      }
      range = { from: args.from, to };
    } else throw new ToolError("bad-args", "Give either from/to (character offsets) or startLine/endLine");
    const before = doc.slice(range.from, range.to);
    if (typeof args.expected === "string" && args.expected !== before) {
      throw new ToolError("bad-args", `The range holds ${JSON.stringify(before.slice(0, 120))}, not the expected text`);
    }
    if (before === args.text) throw new ToolError("bad-args", "The replacement is identical to the current text");
    const lines = (s: string) => (s ? s.split("\n").length : 0);
    const receipt = stageChange(ctx, "replace_range", {
      kind: "range",
      path: ctx.path ?? null,
      from: range.from,
      to: range.to,
      before,
      after: args.text,
      context: rangeContext(doc, range.from, range.to),
      summary: `Replace ${lines(before)} line(s) with ${lines(args.text)} line(s) at ${range.from}–${range.to}`,
    });
    return { ...receipt, ...range };
  },
});

export const EDITOR_TOOLS = [getDocumentTool, getSelectionTool, getHeadingsTool, replaceRangeTool];
