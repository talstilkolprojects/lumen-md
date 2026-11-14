/**
 * Code Doctor — local repair engine for malformed JSON / JSONL.
 *
 * Three layers, in order:
 *   1. tokenize()         — tolerant tokenizer that doesn't throw on
 *                            stray characters, smart-quotes, or unicode.
 *   2. diagnoseJson()     — runs the token stream through a structural
 *                            check; emits typed Diagnostic[] with span
 *                            offsets so callers can highlight the source.
 *   3. repairJson()       — applies up to 6 deterministic repair
 *                            strategies, each with a confidence score.
 *
 * Plus two document-level utilities:
 *   - detectRawJsonRegions(markdown) — finds JSON/JSONL bodies that sit
 *     in plain markdown (outside any code fence) and returns ranges
 *     that the user might want to wrap in ```jsonl.
 *   - wrapInFence(markdown, region, lang) — non-destructive edit that
 *     adds opening/closing fence markers around a region.
 *
 * Pure: no React, no DOM, no network. The block component imports
 * this module; everything testable is here.
 */

import type { Confidence, SourceSpan, Diagnostic } from "./codeDoctorTypes";
export type { Confidence, SourceSpan, DiagnosticCode, Diagnostic, RepairPatch, RepairResult } from "./codeDoctorTypes";
export { tokenize } from "./jsonTokens";
export type { Token, TokenKind } from "./jsonTokens";
import { diagnoseJson } from "./jsonRepair";
export { repairJson, diagnoseJson } from "./jsonRepair";

// ── JSONL line-boundary detection ──────────────────────────────────

export interface JsonlLine {
  /** 1-based line number. */
  line: number;
  /** Span of the line in the original text. */
  span: SourceSpan;
  /** Raw text of the line. */
  raw: string;
  /** Did this line parse standalone? */
  parses: boolean;
  /** Diagnostics for this line (only populated when !parses). */
  diagnostics: Diagnostic[];
}

/**
 * Treats the input as JSONL — one JSON value per non-blank line — and
 * returns per-line parse status. Skips blank lines silently.
 */
export function diagnoseJsonl(text: string): JsonlLine[] {
  const out: JsonlLine[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const start = offset;
    const end = start + raw.length;
    offset = end + 1; // +1 for the newline (off-by-one on \r\n irrelevant here)
    if (!raw.trim()) continue;
    let parses = false;
    let diagnostics: Diagnostic[] = [];
    try {
      JSON.parse(raw);
      parses = true;
    } catch {
      diagnostics = diagnoseJson(raw).map((d) => ({
        ...d,
        span: { start: start + d.span.start, end: start + d.span.end },
      }));
    }
    out.push({
      line: i + 1,
      span: { start, end },
      raw,
      parses,
      diagnostics,
    });
  }
  return out;
}

// ── Document-level: detect raw JSON in markdown outside fences ─────

export interface RawJsonRegion {
  /** Span in the original markdown text. */
  span: SourceSpan;
  /** Best-effort detection: "json", "jsonl", or "json-array". */
  kind: "json" | "jsonl" | "json-array";
  /** First few characters of the region (for UI preview). */
  preview: string;
  /** Confidence that this is actually JSON content. */
  confidence: Confidence;
}

const FENCE_RE = /^```/gm;
const JSONL_HINT = /^\s*\{[\s\S]*?\}\s*$/m;
const JSON_OBJ_HINT = /^\s*\{[\s\S]*\}\s*$/;
const JSON_ARR_HINT = /^\s*\[[\s\S]*\]\s*$/;

/**
 * Scans `markdown` for runs of text that look like JSON / JSONL but
 * sit OUTSIDE any code fence. Returns regions to offer wrapping for.
 *
 * Heuristic, intentionally conservative: only flags blocks where every
 * non-blank line is a parseable JSON value (JSONL) OR the whole block
 * is a single parseable JSON object/array. We do NOT flag scattered
 * inline JSON inside prose paragraphs.
 */
export function detectRawJsonRegions(markdown: string): RawJsonRegion[] {
  // Split on blank-line boundaries to get markdown "blocks", but track
  // absolute offsets so the spans we return refer to the original text.
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  const blockRe = /([\s\S]*?)(?:\n\s*\n|$)/g;
  let m: RegExpExecArray | null;
  let walked = 0;
  while ((m = blockRe.exec(markdown)) !== null && m.index === walked) {
    const block = m[1];
    if (block.length > 0) {
      blocks.push({
        start: m.index,
        end: m.index + block.length,
        text: block,
      });
    }
    walked = m.index + m[0].length;
    if (m[0].length === 0) break;
  }

  // Build a set of offsets that fall inside fenced code blocks; we'll
  // skip blocks that overlap a fence.
  const fenceRanges: Array<[number, number]> = [];
  FENCE_RE.lastIndex = 0;
  const fenceStarts: number[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = FENCE_RE.exec(markdown)) !== null) fenceStarts.push(fm.index);
  for (let i = 0; i + 1 < fenceStarts.length; i += 2) {
    fenceRanges.push([fenceStarts[i], fenceStarts[i + 1]]);
  }
  const inFence = (pos: number) =>
    fenceRanges.some(([s, e]) => pos >= s && pos < e);

  const out: RawJsonRegion[] = [];
  for (const b of blocks) {
    if (inFence(b.start)) continue;
    const trimmed = b.text.trim();
    if (trimmed.length < 8) continue; // too short to be meaningful

    // Case 1: whole block is a JSON object or array.
    if (JSON_OBJ_HINT.test(trimmed) || JSON_ARR_HINT.test(trimmed)) {
      try {
        JSON.parse(trimmed);
        out.push({
          span: { start: b.start, end: b.end },
          kind: JSON_ARR_HINT.test(trimmed) ? "json-array" : "json",
          preview: trimmed.slice(0, 80),
          confidence: "high",
        });
        continue;
      } catch {
        /* why: fall through to JSONL check */
      }
    }

    // Case 2: every non-blank line is a JSON value (JSONL).
    const lines = b.text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length >= 2 && lines.every((l) => JSONL_HINT.test(l))) {
      const allParse = lines.every((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      });
      if (allParse) {
        out.push({
          span: { start: b.start, end: b.end },
          kind: "jsonl",
          preview: lines[0].slice(0, 80),
          confidence: "high",
        });
        continue;
      }
      // At least it has the SHAPE of JSONL (each line a {...}). Surface
      // as a medium-confidence candidate; the user can repair via
      // Code Doctor.
      out.push({
        span: { start: b.start, end: b.end },
        kind: "jsonl",
        preview: lines[0].slice(0, 80),
        confidence: "medium",
      });
    }
  }
  return out;
}

/**
 * Returns a new markdown string with the region wrapped in a fenced
 * code block of language `lang`. Pure: original input unchanged.
 */
export function wrapInFence(
  markdown: string,
  region: SourceSpan,
  lang: string,
): string {
  const before = markdown.slice(0, region.start);
  const body = markdown.slice(region.start, region.end);
  const after = markdown.slice(region.end);
  const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
  const needsTrailingNewline = after.length > 0 && !after.startsWith("\n");
  return (
    before +
    (needsLeadingNewline ? "\n" : "") +
    "```" +
    lang +
    "\n" +
    body.replace(/\s+$/, "") +
    "\n```" +
    (needsTrailingNewline ? "\n" : "") +
    after
  );
}

/**
 * Predicate used by `CodeDoctorBlock` to decide whether to render the
 * inline DataTable preview after a successful repair.
 *
 * Returns true only when the value is an array of plain objects AND
 * every value in every record is scalar (string / number / boolean /
 * null). Skipping array-valued records avoids a misleading column
 * type: parseJSONTable's `inferType` stringifies arrays to "1,2,3",
 * which Date.parse can return a real number for on some engines —
 * causing an `items` column of arrays to be typed as DATE.
 *
 * Lives in the engine module (not in the React block) so it's
 * unit-testable without mounting the UI.
 */
export function isAllScalarRecordList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const r of value) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
    for (const v of Object.values(r as Record<string, unknown>)) {
      if (
        v !== null &&
        typeof v !== "string" &&
        typeof v !== "number" &&
        typeof v !== "boolean"
      ) {
        return false;
      }
    }
  }
  return true;
}
