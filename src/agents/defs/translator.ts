/**
 * translator — `ai.translate`. Translates Markdown into a target language
 * while keeping its structure. Long documents are translated chunk by
 * chunk (never splitting a code fence); each chunk is checked:
 * fenced code and every URL (inline, reference, autolink, bare) must
 * survive unchanged, and the
 * output must be written in the target language's script when that
 * script is distinctive (Hebrew, Arabic, Cyrillic, CJK) — the most common
 * local-model failure is answering in English — and, where the script is
 * shared, in the target language by local language identification.
 */

import type { AgentDefinition, AgentInput, ValidationResult } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { fail, ok, scriptOf } from "./shared";

export interface TranslatorInput extends AgentInput {
  text: string;
  extra: { targetLanguage: string };
}

export const CHUNK_CHARS = 3500;

type Script = ReturnType<typeof scriptOf>;

/** The script a target-language name or code implies, when it is distinctive. */
export function expectedScript(targetLanguage: string): Script | null {
  const t = targetLanguage.trim().toLowerCase();
  if (/^(he|heb|hebrew|iw|עברית|ivrit)$/.test(t)) return "hebrew";
  if (/^(ar|ara|arabic|العربية|arabe|fa|persian|farsi|فارسی|ur|urdu)$/.test(t)) return "arabic";
  if (/^(ru|rus|russian|русский|uk|ukrainian|українська|bg|bulgarian|sr|serbian)$/.test(t)) return "cyrillic";
  if (/^(zh|zh-cn|zh-tw|chinese|中文|汉语|ja|jp|japanese|日本語|ko|korean|한국어)$/.test(t)) return "cjk";
  if (/^(en|eng|english|es|spanish|español|fr|french|français|de|german|deutsch|it|italian|pt|portuguese|nl|dutch|sv|swedish|pl|polish|tr|turkish|cs|czech)$/.test(t)) return "latin";
  return null;
}

/**
 * Split Markdown into chunks of about CHUNK_CHARS, never inside a code
 * fence: at a blank line when one comes, else — for a long table, list or
 * paragraph with no blank line — at a line boundary once the chunk is a
 * quarter over the target. `chunks.join("\n")` is the original text.
 */
export function chunkMarkdown(text: string, max = CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    current.push(line);
    size += line.length + 1;
    if (!inFence && (size >= max && line.trim() === "" || size >= max * 1.25)) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

/** Every link / image / reference-definition / autolink / bare URL target, sorted (a multiset). */
export function urlsOf(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) out.push(m[1]);
  // Link reference definitions; a footnote definition ("[^1]: text") is prose, not a target.
  for (const m of s.matchAll(/^\s{0,3}\[[^\]^][^\]]*\]:\s*<?(\S+?)>?(?:\s|$)/gm)) out.push(m[1]);
  for (const m of s.matchAll(/<((?:https?|mailto|ftp):[^>\s]+)>/g)) out.push(m[1]);
  // Bare URLs not already captured as a link target above.
  const linked = s.replace(/!?\[[^\]]*\]\([^)]*\)/g, " ").replace(/^\s{0,3}\[[^\]]+\]:.*$/gm, " ").replace(/<(?:https?|mailto|ftp):[^>\s]+>/g, " ");
  for (const m of linked.matchAll(/\bhttps?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g)) out.push(m[0]);
  return out.sort();
}

/** The contents of every fenced code block, in order (trailing spaces ignored). */
export function fencedBlocks(s: string): string[] {
  const out: string[] = [];
  let open: { marker: string; body: string[] } | null = null;
  for (const line of s.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!open) {
      if (m) open = { marker: m[1][0], body: [] };
    } else if (m && m[1][0] === open.marker) {
      out.push(open.body.map((l) => l.replace(/\s+$/, "")).join("\n"));
      open = null;
    } else open.body.push(line);
  }
  return out;
}

/** The prose of a Markdown text: no code blocks, inline code, URLs or frontmatter — what the script check should look at. */
export function proseOf(s: string): string {
  return s
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, " $1 ")
    .replace(/https?:\/\/\S+/g, " ");
}
const fenceCount = (s: string): number => (s.match(/^\s*(```|~~~)/gm) ?? []).length;

/** Structure must survive: same fences with the same code, same URLs in every link form; script must match the target. */
export function checkTranslation(output: string, source: string, targetLanguage: string): ValidationResult {
  if (!output.trim()) return fail("empty translation");
  if (fenceCount(output) !== fenceCount(source)) return fail("code fences changed", "Keep every ``` code block exactly as in the source, untranslated.");
  const codeA = fencedBlocks(source);
  const codeB = fencedBlocks(output);
  if (codeA.some((c, i) => c !== codeB[i])) return fail("code inside a fenced block changed", "Copy every code block character for character; do not translate code or its comments.");
  const a = urlsOf(source);
  const b = urlsOf(output);
  if (a.length !== b.length || a.some((u, i) => u !== b[i])) return fail("link or image URLs changed", "Keep every link and image URL exactly as in the source.");
  const want = expectedScript(targetLanguage);
  const got = scriptOf(proseOf(output));
  if (want && want !== "latin" && got !== want) return fail(`output is not written in ${targetLanguage}`, `Write the whole translation in ${targetLanguage}; translate every sentence.`);
  if (want === "latin" && scriptOf(proseOf(source)) !== "latin" && got !== "latin") return fail(`output is not written in ${targetLanguage}`, `Write the whole translation in ${targetLanguage}.`);
  return ok;
}

/**
 * Where the script cannot tell (English → French, Russian → Ukrainian),
 * local language identification (plan 6.5) does: a confident guess other
 * than the target language fails the chunk. Targets the detector cannot
 * report (unknown names, languages franc-min lacks), short or unclear text,
 * and a detector that failed to load all pass: the structural and script
 * checks still apply.
 */
export async function checkTranslationLanguage(output: string, source: string, targetLanguage: string): Promise<ValidationResult> {
  let lang: typeof import("../../text/langId");
  try {
    lang = await import("../../text/langId");
  } catch {
    return ok;
  }
  const target = lang.languageCode(targetLanguage);
  if (!target || !lang.DETECTABLE.has(target)) return ok;
  const got = lang.detectLanguage(proseOf(output));
  if (!got.confident || got.lang === "und" || got.lang === target) return ok;
  const src = lang.detectLanguage(proseOf(source));
  if (src.confident && src.lang === got.lang) return fail(`output is still in the source language (${got.lang}), not ${targetLanguage}`, `Translate every sentence into ${targetLanguage}; do not copy the source.`);
  return fail(`output is in ${got.lang}, not ${targetLanguage}`, `Write the whole translation in ${targetLanguage}.`);
}

export const translatorAgent: AgentDefinition<TranslatorInput, string> = registerAgent({
  id: "translator",
  splittable: true,
  language: "any",
  commandId: "ai.translate",
  description: "Translate Markdown into another language, preserving structure",
  system: (input) =>
    `You are a translation engine. Translate the user's Markdown into ${input.extra.targetLanguage}. Preserve all ` +
    "Markdown structure exactly: headings, lists, tables, emphasis, YAML frontmatter keys, code blocks (do not " +
    "translate code), inline code, and every link and image URL. Translate every sentence; do not summarise, " +
    "do not add notes. Output ONLY the translated Markdown.",
  user: (input) => input.text,
  parse: (text) => text.trim(),
  validators: [
    { name: "translation", check: (out, input) => checkTranslation(out, input.text ?? "", (input as TranslatorInput).extra.targetLanguage) },
    { name: "target language", check: (out, input) => checkTranslationLanguage(out, input.text ?? "", (input as TranslatorInput).extra.targetLanguage) },
  ],
  // The whole note, when the text given is only part of it (5.3.1, 5.3.3).
  tools: pickTools("get_document"),
  maxSteps: 3,
  tier: "small",
  temperature: 0.2,
  maxTokens: 4000,
  cache: true,
});
