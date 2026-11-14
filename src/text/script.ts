/**
 * Script detection (plan 6.5) — tiny and synchronous, safe for the startup
 * bundle. It answers "which writing system is this prose in?" and, where a
 * script belongs to one language for Lumen's purposes (Hebrew, Japanese
 * kana, Hangul, Greek, Thai…), which language. Scripts shared by many
 * languages (Latin, Cyrillic, Arabic, Devanagari) need the trigram model in
 * ./langId.ts, which is loaded on demand.
 */

export type Script = "hebrew" | "arabic" | "cyrillic" | "latin" | "han" | "kana" | "hangul" | "greek" | "devanagari" | "thai" | "other";

const SCRIPTS: Array<[Exclude<Script, "other">, RegExp]> = [
  ["hebrew", /\p{Script=Hebrew}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["latin", /\p{Script=Latin}/u],
  ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["han", /\p{Script=Han}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["greek", /\p{Script=Greek}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["thai", /\p{Script=Thai}/u],
];

/**
 * The prose of a text: no fenced or inline code, HTML tags, URLs, e-mail
 * addresses or Markdown link targets — the parts that are not "in" any
 * language and would pull Hebrew prose towards Latin.
 */
export function proseForLanguage(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<\/?[A-Za-z][^<>]*>/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/\b(?:https?|ftp|mailto):[^\s<>()]+/gi, " ")
    .replace(/\bwww\.[^\s<>()]+/gi, " ")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ");
}

/** Letters per script in (the prose of) a text, from the first 4000 characters. */
export function scriptCounts(text: string): Record<Script, number> {
  const counts: Record<Script, number> = { hebrew: 0, arabic: 0, cyrillic: 0, latin: 0, han: 0, kana: 0, hangul: 0, greek: 0, devanagari: 0, thai: 0, other: 0 };
  for (const ch of proseForLanguage(text.slice(0, 4000))) {
    if (!/\p{L}/u.test(ch)) continue;
    const hit = SCRIPTS.find(([, re]) => re.test(ch));
    counts[hit ? hit[0] : "other"]++;
  }
  return counts;
}

/**
 * The dominant script, or null when there are no letters. Kana anywhere in
 * Han text makes it Japanese (kanji are Han too): "kana" wins over "han"
 * whenever the two together dominate and there is any kana.
 */
export function dominantScript(text: string): Script | null {
  const c = scriptCounts(text);
  const merged: Record<Script, number> = { ...c };
  if (c.kana > 0) {
    merged.kana = c.kana + c.han;
    merged.han = 0;
  }
  let best: Script | null = null;
  for (const k of Object.keys(merged) as Script[]) if (merged[k] > 0 && (best === null || merged[k] > merged[best])) best = k;
  return best;
}

/** The language a script implies on its own (BCP-47 primary tag), when it does. */
export const SCRIPT_LANGUAGE: Partial<Record<Script, string>> = { hebrew: "he", kana: "ja", han: "zh", hangul: "ko", greek: "el", thai: "th" };

/**
 * Yiddish is written in Hebrew letters: its ligatures, or two of its
 * common function words, tell it from Hebrew.
 */
export function looksYiddish(text: string): boolean {
  if (/[װ-ײ]|ײַ/.test(text)) return true;
  const words = text.split(/[^\p{L}\p{M}"'׳״]+/u).filter(Boolean);
  const markers = new Set(["איז", "ניט", "נישט", "דער", "דאס", "גייט", "עס", "גוטן", "איך", "זיין", "האט", "פון", "װי", "ווי", "און"]);
  return words.filter((w) => markers.has(w)).length >= 2;
}

/**
 * The language from the script alone (sync): "he" for Hebrew prose, "ja"
 * for kana, "zh" for Han only, "und" without letters — or null when the
 * script is shared by several languages and the trigram model must decide.
 */
export function languageFromScript(text: string): string | null {
  const s = dominantScript(text);
  if (s === null) return "und";
  if (s === "hebrew") return looksYiddish(text) ? "yi" : "he";
  return SCRIPT_LANGUAGE[s] ?? null;
}
