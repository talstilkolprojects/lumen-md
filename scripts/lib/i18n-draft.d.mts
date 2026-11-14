/** Types for ./i18n-draft.mjs (translation drafts, plan 9.6). */
import type { Strings } from "./i18n-files.mjs";

export type Review = Record<string, Record<string, string>>;
export interface Engine {
  id: string;
  translate(texts: string[], lang: string): Promise<string[]>;
}
export const REVIEW_DIR: string;
export const DRAFT_LOCALES: string[];
export function sourceHash(text: string): string;
export function readNeedsReview(dir?: string): Review;
export function writeNeedsReview(review: Review, dir?: string): void;
export function unreviewed(lang: string, en: Strings, review: Review): string[];
export function protect(text: string): { masked: string; restore(out: string): string | null };
export function acceptDraft(source: string, draft: unknown): string | null;
export function draftMissing(opts: {
  en: Strings;
  locales: Record<string, Strings>;
  engine: Engine;
  keys?: string[];
  review?: Review;
}): Promise<{ drafts: Record<string, Strings>; rejected: Array<{ lang: string; key: string; reason: string }>; review: Review }>;
export function approve(review: Review, lang: string, keys?: string[]): number;
export function ollamaEngine(opts?: { host?: string; model?: string; fetchImpl?: typeof fetch }): Engine;
export function fakeEngine(): Engine;
