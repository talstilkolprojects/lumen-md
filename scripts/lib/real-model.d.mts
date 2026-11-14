// Types for scripts/lib/real-model.mjs (plan 7.2), for the tests.
export interface OllamaTagModel {
  name: string;
  model?: string;
  digest?: string;
}
export interface HebrewSmokePrompt {
  id: string;
  prompt: string;
  anyOf?: string[];
}
export interface HebrewSmokeResult {
  id: string;
  ok: boolean;
  detail: string;
  answer: string;
  ms: number;
}
export declare const HEBREW_SMOKE_MODEL: string;
export declare const HEBREW_SMOKE_PROMPTS: HebrewSmokePrompt[];
export declare const MIN_HEBREW_SHARE: number;
export declare function findModel(tags: { models?: OllamaTagModel[] } | null | undefined, model: string): OllamaTagModel | null;
export declare function normalizeDigest(digest: string | null | undefined): string;
export declare function digestMismatch(entry: OllamaTagModel | null | undefined, pinned: string | null | undefined): string | null;
export declare function stripThinking(text: string | null | undefined): string;
export declare function hebrewShare(text: string | null | undefined): number;
export declare function judgeHebrewAnswer(item: HebrewSmokePrompt, raw: string): { ok: boolean; detail: string };
export declare function formatHebrewSmokeReport(results: HebrewSmokeResult[], meta: { model: string; url: string; date: string; ms: number; digest?: string }): string;
