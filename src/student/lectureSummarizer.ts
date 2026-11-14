/**
 * Student mode's checked summary (plan W5.13 step 3, plan 6.11; audit
 * W10.C9): the `summarizer` agent — local models only (Ollama, then the
 * in-browser model), every sentence copied from the text and checked by
 * its `grounded` validator — picks the lecture's summary sentences.
 *
 * Its lines are mapped back to transcript sentences (a line, or each part
 * of a line shortened with "…", inside one sentence); `processLecture`
 * then checks the picked sentences against the transcript once more
 * (`verifySummary`). With no local model, or when the check fails, the
 * extractive summary is kept, and the note and the recorder say which
 * one the user got.
 *
 * Registered by the lecture recorder before a lecture is processed.
 */
import { setLectureSummarizer, type LectureSummarizer } from "./lecture";
import type { TimedText } from "./lectureCore";

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The transcript sentence each summary line comes from (in the lines' order, once each); lines from nowhere are dropped. */
export function sentencesOfSummary(lines: readonly string[], sentences: readonly TimedText[]): number[] {
  const texts = sentences.map((s) => squash(s.text));
  const out: number[] = [];
  for (const line of lines) {
    const parts = line.split("…").map(squash).filter((p) => p.length > 1);
    if (!parts.length) continue;
    const i = texts.findIndex((t) => parts.every((p) => t.includes(p)));
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out;
}

/** Runs the summarizer agent; resolves to its text, or rejects (no local model, the check failed). */
export type SummaryRun = (text: string, opts: { language: string; sentences: number; signal?: AbortSignal }) => Promise<string>;

const agentRun: SummaryRun = async (text, { language, sentences, signal }) => {
  const [{ runAgentOrThrow }, { summarizerAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs/summarizer")]);
  return runAgentOrThrow(summarizerAgent, { text, extra: { language, sentences } }, { signal });
};

/** The checked summarizer over a summary run (the agent by default). */
export function checkedLectureSummarizer(run: SummaryRun = agentRun, language = "the lecture's language"): LectureSummarizer {
  return async (sentences, important, signal) => {
    if (!sentences.length) return [];
    const target = Math.max(3, Math.min(8, Math.round(sentences.length / 6), sentences.length));
    const out = await run(sentences.map((s) => s.text).join(" "), { language, sentences: Math.max(target, important.size ? Math.min(8, important.size) : 0), signal });
    const { summarySentences } = await import("../ai/summarizeCore");
    return sentencesOfSummary(summarySentences(out), sentences);
  };
}

/** Plug the checked summarizer into processLecture (the recorder calls this before processing). */
export function registerLectureSummarizer(run?: SummaryRun, language?: string): void {
  setLectureSummarizer(checkedLectureSummarizer(run, languageName(language)));
}

const NAMES: Record<string, string> = { he: "Hebrew", en: "English", ar: "Arabic", ru: "Russian", fr: "French", de: "German", ja: "Japanese", zh: "Chinese" };
/** The prompt names the language ("Hebrew"), not its tag ("he-IL"). */
export const languageName = (tag?: string): string | undefined => (tag ? (NAMES[tag.split(/[-_]/)[0].toLowerCase()] ?? tag) : undefined);
