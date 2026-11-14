/**
 * "Suggest a better translation" (plan W4.18), without a server: find the
 * string the person means among the active language's strings, and build a
 * github.com "new issue" link with the key, the English source, the current
 * translation and the suggestion. Nothing is sent: the person's click opens
 * the link (src/ui/TranslationSuggest.tsx). Pure.
 */
import { FEEDBACK_REPO, MAX_ISSUE_URL } from "../feedback/feedback";

export interface StringMatch {
  key: string;
  current: string;
  english: string;
}

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** Strings whose translation contains `text` (or whose English does), best first: exact, then shortest. */
export function findStrings(text: string, current: Record<string, string>, english: Record<string, string>, max = 8): StringMatch[] {
  const q = norm(text);
  if (q.length < 2) return [];
  const out: Array<StringMatch & { score: number }> = [];
  for (const [key, en] of Object.entries(english)) {
    const cur = current[key] ?? en;
    const a = norm(cur);
    const b = norm(en);
    const score = a === q ? 0 : a.includes(q) ? 1 : b === q ? 2 : b.includes(q) ? 3 : -1;
    if (score >= 0) out.push({ key, current: cur, english: en, score });
  }
  return out
    .sort((x, y) => x.score - y.score || x.current.length - y.current.length || (x.key < y.key ? -1 : 1))
    .slice(0, max)
    .map((m) => ({ key: m.key, current: m.current, english: m.english }));
}

export interface SuggestionInput extends StringMatch {
  locale: string;
  suggestion: string;
  note?: string;
  version: string;
}

export function suggestionTitle(s: Pick<SuggestionInput, "locale" | "key">): string {
  return `[i18n:${s.locale}] ${s.key}`;
}

export function suggestionBody(s: SuggestionInput): string {
  const fence = (t: string) => "```\n" + t.replace(/```/g, "ˋˋˋ") + "\n```";
  return [
    `**Language:** ${s.locale}`,
    `**Key:** \`${s.key}\``,
    "",
    "**English (source):**",
    fence(s.english),
    "**Current translation:**",
    fence(s.current),
    "**Suggested translation:**",
    fence(s.suggestion),
    ...(s.note?.trim() ? ["**Why:**", s.note.trim()] : []),
    "",
    `<sub>Lumen ${s.version} · sent from "Suggest a better translation" (plan W4.18). The file is \`src/i18n/locales/${s.locale}/\`; keep every {placeholder}.</sub>`,
  ].join("\n");
}

/** github.com's new-issue form, filled in; the title alone when the body would make the link too long. */
export function suggestionLink(s: SuggestionInput, repo = FEEDBACK_REPO): { url: string; withBody: boolean } {
  const base = `https://github.com/${repo}/issues/new`;
  const q = (body?: string) => {
    const p = new URLSearchParams({ title: suggestionTitle(s), labels: `i18n,locale:${s.locale}` });
    if (body !== undefined) p.set("body", body);
    return `${base}?${p.toString()}`;
  };
  const full = q(suggestionBody(s));
  return full.length <= MAX_ISSUE_URL ? { url: full, withBody: true } : { url: q(), withBody: false };
}
