/**
 * researcher — `research.ask` (plan 5.4, T14). A real agent in a tool loop,
 * on a local model: it searches, reads the pages it chooses, pulls the
 * passages it wants to cite with `extract_quotes`, and answers with a
 * report whose every claim carries a footnote marker and a verbatim quote.
 *
 * Two modes, picked by the command from the AI policy and the research
 * settings (`research/agent.ts`):
 *   web      `search_web` → `fetch_page` → `extract_quotes`. Only the query
 *            and the page address leave the device, and under the local-only
 *            policy every call asks the user first (the runtime's network
 *            gate; plan 2.7's approval when outside content is in the run).
 *   library  the clipped pages (`Library/`, `ספרייה/`): `search_workspace`
 *            with `folder`, `read_file`, `extract_quotes` with `path`.
 *            Nothing leaves the device.
 *
 * The deterministic checks stay outside the model: the `cited` validator
 * refuses an answer that cites nothing it read, and `verified` refuses one
 * whose quotes are not in their sources (the critic then retries with
 * "quote word for word"). The command builds the footnotes and flags what
 * remains unverified (`research/agent.ts`), as before.
 *
 * Everything the model reads here is outside content: the runtime cleans
 * and delimits every page, snippet and library note (plan 2.7), and the
 * report it writes is saved with `untrusted: true`.
 */

import type { AgentDefinition, AgentInput, ValidationContext, ValidationResult } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { APPROXIMATE_AT, quoteCoverage } from "../../research/citations";
import { clip, fail, ok } from "./shared";

export type ResearchMode = "web" | "library";

export interface ResearcherInput extends AgentInput {
  /** The question. */
  text: string;
  extra: {
    mode: ResearchMode;
    /** Library mode: the folders of the clip library that exist (`Library/`, `ספרייה/`). */
    folders?: string[];
    /** At most this many sources (default 6). */
    maxSources?: number;
  };
}

export interface ResearchSource {
  /** The number the report cites: [^n]. */
  n: number;
  /** Web mode: the page's address as `fetch_page` returned it. */
  url?: string;
  /** Library mode: the note's workspace path. */
  path?: string;
  title?: string;
}

export interface ResearchQuote {
  /** The source cited. */
  n: number;
  /** Which of that source's markers this quote supports (1 for the first…). Omitted: in marker order. */
  i?: number;
  /** A passage copied verbatim from the source. */
  quote: string;
}

export interface ResearcherOutput {
  /** Markdown with a footnote marker `[^n]` after every claim. */
  report: string;
  sources: ResearchSource[];
  quotes: ResearchQuote[];
}

export const RESEARCHER_SCHEMA = {
  type: "object",
  properties: {
    report: { type: "string", minLength: 1 },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer", minimum: 1 }, url: { type: "string" }, path: { type: "string" }, title: { type: "string" } },
        required: ["n"],
        additionalProperties: false,
      },
    },
    quotes: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer", minimum: 1 }, i: { type: "integer", minimum: 1 }, quote: { type: "string" } },
        required: ["n", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["report", "sources", "quotes"],
  additionalProperties: false,
};

const MARKER = /\[\^(\d+)\]/g;

/** The source numbers the report cites, in order of first appearance. */
export function citedNumbers(report: string): number[] {
  const out: number[] = [];
  for (const m of report.matchAll(MARKER)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The report cites at least one source it lists, and every marker names a listed source. */
export function checkCited(out: ResearcherOutput): ValidationResult {
  const listed = new Set(out.sources.map((s) => s.n));
  const cited = citedNumbers(out.report);
  if (!cited.length) return fail("the report cites no source", "After every claim add a footnote marker with the source number, like [^1], and list that source in `sources`.");
  const unknown = cited.filter((n) => !listed.has(n));
  if (unknown.length) return fail(`the report cites sources that are not listed: ${unknown.join(", ")}`, "List every cited source in `sources` with the url (or path) you read it from.");
  if (!out.quotes.some((q) => q.quote.trim())) return fail("no supporting quotes", "For every footnote marker give a passage copied word for word from that source in `quotes`.");
  return ok;
}

/** The text of a source the run read: a fetched page by URL, or a library note by path. */
export async function sourceText(src: ResearchSource, ctx?: ValidationContext): Promise<string | null> {
  if (src.url) {
    const page = ctx?.pages.get(src.url) ?? [...(ctx?.pages.values() ?? [])].find((p) => p.finalUrl === src.url);
    return page?.text ?? null;
  }
  if (src.path) {
    try {
      const { readWorkspaceFile } = await import("../../storage/workspace");
      return await readWorkspaceFile(src.path);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Every quote is in its source (word for word, or nearly: `APPROXIMATE_AT`
 * coverage), and every source cited was read in this run. One or two
 * paraphrased quotes are flagged by the command rather than retried: the
 * validator refuses only when fewer than half verify, so a run that
 * mostly quotes right is not thrown away.
 */
export async function checkVerified(out: ResearcherOutput, ctx?: ValidationContext): Promise<ValidationResult> {
  const texts = new Map<number, string | null>();
  for (const s of out.sources) texts.set(s.n, await sourceText(s, ctx));
  const unread = citedNumbers(out.report).filter((n) => texts.get(n) == null);
  if (unread.length) return fail(`cited sources that were not read in this run: ${unread.join(", ")}`, "Cite only pages you read with fetch_page (or notes you read with read_file) in this run, by the address you read.");
  const quotes = out.quotes.filter((q) => q.quote.trim());
  let found = 0;
  for (const q of quotes) {
    const text = texts.get(q.n);
    if (text && quoteCoverage(q.quote, text) >= APPROXIMATE_AT) found++;
  }
  if (quotes.length && found / quotes.length < 0.5) {
    return fail(`${quotes.length - found} of ${quotes.length} quotes are not in their sources`, "Copy each quote word for word from the source text (use extract_quotes to get the exact passage); do not paraphrase.");
  }
  return ok;
}

const SYSTEM_WEB =
  "You are a careful research agent. Answer the user's question from web sources you read in this conversation, in a well-structured Markdown report: " +
  "a two-sentence summary first, then sections with short paragraphs. State only what the sources support, say where they disagree or where evidence is thin, " +
  "and never invent facts, numbers or sources.\n\n" +
  "How to work: call search_web with 1-3 short queries; call fetch_page on the 2-6 most relevant results; call extract_quotes with the passages you want to cite " +
  "(it returns their exact text); then answer. After every claim put a footnote marker with the source number, like [^2]. " +
  'Final answer: JSON only, {"report": "<markdown with [^n] markers>", "sources": [{"n": 1, "url": "<the url you fetched>", "title": "..."}], ' +
  '"quotes": [{"n": 1, "i": 1, "quote": "<a passage copied word for word from source 1 that supports its first claim>"}]} — one quote per marker, in the order the markers appear ("i" counts the markers of that source). ' +
  "Write the report in the language of the question.";

const SYSTEM_LIBRARY =
  "You are a careful research agent. Answer the user's question from the notes in the user's clip library only (nothing else is available), in a well-structured Markdown report: " +
  "a two-sentence summary first, then sections with short paragraphs. State only what the notes support, and never invent facts, numbers or sources.\n\n" +
  "How to work: call search_workspace with the key words and `folder` set to a library folder; call read_file on the 2-6 most relevant notes; call extract_quotes with `path` and the passages you want to cite; then answer. " +
  "After every claim put a footnote marker with the source number, like [^2]. " +
  'Final answer: JSON only, {"report": "<markdown with [^n] markers>", "sources": [{"n": 1, "path": "<the note path you read>", "title": "..."}], ' +
  '"quotes": [{"n": 1, "i": 1, "quote": "<a passage copied word for word from note 1 that supports its first claim>"}]} — one quote per marker, in the order the markers appear. ' +
  "Write the report in the language of the question.";

export const researcherAgent: AgentDefinition<ResearcherInput, ResearcherOutput> = registerAgent({
  id: "researcher",
  commandId: "research.ask",
  description: "Research a question from the web or the clip library, with verified verbatim quotes",
  system: (input) => (input.extra.mode === "library" ? SYSTEM_LIBRARY : SYSTEM_WEB),
  user: (input) => {
    const parts = [`Question: ${clip(input.text, 2000)}`];
    if (input.extra.mode === "library") parts.push(`Library folders: ${(input.extra.folders?.length ? input.extra.folders : ["Library/"]).join(", ")}`);
    parts.push(`Read at most ${input.extra.maxSources ?? 6} sources.`);
    return parts.join("\n");
  },
  tools: pickTools("search_web", "fetch_page", "extract_quotes", "search_workspace", "read_file"),
  requires: [],
  outputSchema: RESEARCHER_SCHEMA,
  validators: [
    { name: "cited", check: (out) => checkCited(out) },
    { name: "verified", check: (out, _input, ctx) => checkVerified(out, ctx) },
  ],
  // The report is in the question's language; the runtime's own check sees to that.
  language: "input",
  tier: "medium",
  maxSteps: 14,
  maxRetries: 1,
  temperature: 0.2,
  maxTokens: 3000,
});
