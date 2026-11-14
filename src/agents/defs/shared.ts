/**
 * Helpers shared by the agent definitions: text budgets, output cleanup
 * and small validators that several agents reuse.
 */

import type { ValidationResult } from "../types";

/** Keep prompts inside what a small local model handles well. */
export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…" : text;
}

/** Strip one pair of surrounding ``` fences a model may have added. */
export function stripFences(s: string): string {
  return s
    .replace(/^\s*```[a-zA-Z-]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/** Language hint for prompts: the document's script decides, not the UI locale. */
export function scriptOf(text: string): "hebrew" | "arabic" | "cyrillic" | "cjk" | "latin" {
  const sample = text.slice(0, 2000);
  const count = (re: RegExp) => (sample.match(re) ?? []).length;
  const he = count(/[֐-׿]/g);
  const ar = count(/[؀-ۿ]/g);
  const cy = count(/[Ѐ-ӿ]/g);
  const cjk = count(/[぀-ヿ一-鿿가-힯]/g);
  const la = count(/[A-Za-z]/g);
  const best = Math.max(he, ar, cy, cjk, la);
  if (best === 0) return "latin";
  if (best === he) return "hebrew";
  if (best === ar) return "arabic";
  if (best === cy) return "cyrillic";
  if (best === cjk) return "cjk";
  return "latin";
}

export const ok: ValidationResult = { ok: true };
export const fail = (reason: string, hint?: string): ValidationResult => ({ ok: false, reason, hint });
