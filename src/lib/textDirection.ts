/**
 * Base text direction of a piece of content, the way `dir="auto"` decides
 * it (UAX #9, rule P2: the first strong character wins).
 *
 * Shared by the exporters: an HTML export of a Hebrew note has to say
 * `<html dir="rtl">`, or every browser opens it as left-to-right text with
 * the punctuation on the wrong side.
 */

export type BaseDirection = "ltr" | "rtl";

// Hebrew, Arabic, Syriac, Thaana, N'Ko and the presentation-form blocks.
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
// Inside those blocks, the characters that are *not* strong under UAX #9:
// Hebrew and Arabic combining marks (NSM), the Arabic-Indic and Extended
// Arabic-Indic digits (AN / EN) and the Arabic number separators (AN). A
// cell of "١٢" has no direction of its own and must not turn a table RTL.
const WEAK_IN_RTL_BLOCKS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0660-\u066C\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9]/;
// Latin (with the Latin-1 / Extended ranges), Greek, Cyrillic, kana, CJK
// ideographs and Hangul: all strong left-to-right.
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿가-힯]/;

/** Direction of the first strong character, or null when there is none. */
export function firstStrongDirection(text: string): BaseDirection | null {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) {
      if (WEAK_IN_RTL_BLOCKS.test(ch)) continue;
      return "rtl";
    }
    if (LTR_CHAR.test(ch)) return "ltr";
  }
  return null;
}

/**
 * Base direction of a Markdown document: its first strong character after
 * the YAML frontmatter and outside fenced code (code is always LTR and
 * would otherwise decide for a Hebrew note that starts with a snippet).
 * A frontmatter `dir:` key pins the answer. Defaults to LTR.
 */
export function markdownBaseDirection(markdown: string): BaseDirection {
  let body = markdown;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) {
      const pinned = /^dir:\s*["']?(ltr|rtl)["']?\s*$/m.exec(body.slice(3, end));
      if (pinned) return pinned[1] as BaseDirection;
      body = body.slice(end + 4);
    }
  }
  body = body.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "");
  return firstStrongDirection(body) ?? "ltr";
}

/**
 * BCP 47 tag for the script of the first strong character, when it tells
 * the language on its own: Hebrew → "he", Arabic → "ar". Latin, Cyrillic
 * and CJK are shared by too many languages to guess, so null.
 */
export function scriptLanguage(text: string): "he" | "ar" | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return "he";
    if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return "ar";
    if (LTR_CHAR.test(ch)) return null;
  }
  return null;
}

/** Does the text contain any right-to-left character (presentation forms included)? */
export function hasRtl(text: string): boolean {
  return RTL_CHAR.test(text);
}

/**
 * The language of the first Hebrew or Arabic character, skipping Latin and
 * everything else: which RTL language a mixed document needs, wherever
 * its first RTL passage is.
 */
export function firstRtlLanguage(text: string): "he" | "ar" | null {
  for (const ch of text) {
    if (!RTL_CHAR.test(ch)) continue;
    const lang = scriptLanguage(ch);
    if (lang) return lang;
  }
  return null;
}

