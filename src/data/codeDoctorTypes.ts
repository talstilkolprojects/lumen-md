/** Code Doctor types (split out of codeDoctor.ts, plan W4.11; it re-exports them). */

// ── Types ────────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface SourceSpan {
  /** Start offset (UTF-16 chars) in the original input. */
  start: number;
  /** End offset, exclusive. */
  end: number;
}

export type DiagnosticCode =
  | "smart-quote"
  | "single-quote-string"
  | "trailing-comma"
  | "missing-comma"
  | "unquoted-key"
  | "unclosed-brace"
  | "unclosed-bracket"
  | "stray-token"
  | "empty-input"
  | "ok";

export interface Diagnostic {
  code: DiagnosticCode;
  span: SourceSpan;
  message: string;
  confidence: Confidence;
}

export interface RepairPatch {
  span: SourceSpan;
  replacement: string;
  reason: DiagnosticCode;
  confidence: Confidence;
}

export interface RepairResult {
  /** The repaired text (best-effort). Equal to input if nothing applied. */
  output: string;
  /** Patches applied, in original-text order. */
  patches: RepairPatch[];
  /** Diagnostics that survived the repair (if any). */
  remaining: Diagnostic[];
  /** True iff `JSON.parse(output)` succeeds. */
  parses: boolean;
}
