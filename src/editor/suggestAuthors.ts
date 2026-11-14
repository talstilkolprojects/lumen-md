/**
 * Suggestions by author (W3.11): who suggested what, and accepting or
 * rejecting one person's suggestions without touching anyone else's.
 * The AI is an author like any other (`AI_AUTHOR`), so AI-written
 * suggestions show, and resolve, as the AI's.
 */
import { mayContainCriticMarkup, parseSuggestions, resolutionChanges, type Resolution, type Suggestion } from "./suggesting";

/** The author name AI-made suggestions carry (`{>>@AI<<}`). */
export const AI_AUTHOR = "AI";

export const isAiAuthor = (a: string | undefined | null) => !!a && a.trim().toLowerCase() === AI_AUTHOR.toLowerCase();

/** Changes that carry an author: insertions, deletions and substitutions. */
const isChange = (s: Suggestion) => s.kind === "insert" || s.kind === "delete" || s.kind === "substitute";

export interface AuthorCount {
  /** The author's name; null for suggestions without an author tag. */
  author: string | null;
  count: number;
  ai: boolean;
}

/** Authors of the suggestions in a text, most suggestions first. */
export function suggestionAuthors(text: string): AuthorCount[] {
  const counts = new Map<string | null, number>();
  for (const s of parseSuggestions(text)) {
    if (!isChange(s)) continue;
    const a = s.author ?? null;
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts]
    .map(([author, count]) => ({ author, count, ai: isAiAuthor(author) }))
    .sort((x, y) => y.count - x.count || (x.author === null ? 1 : y.author === null ? -1 : x.author.localeCompare(y.author)));
}

/** Accept or reject only `author`'s suggestions (null: those without an author). */
export function resolveByAuthor(text: string, author: string | null, mode: Resolution): string {
  const mine = parseSuggestions(text).filter((s) => isChange(s) && (s.author ?? null) === author);
  const changes = resolutionChanges(text, mine, mode);
  let out = text;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}

/** A stable hue per author, for the author colours (iA Writer style). */
export function authorHue(author: string | null): number {
  if (!author) return 220;
  if (isAiAuthor(author)) return 280;
  let h = 0;
  for (const ch of author) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/** A cheap key that changes when the set of authors (or their counts) does: for memo dependencies. */
export function suggestionAuthorsKey(text: string): string {
  if (!mayContainCriticMarkup(text)) return "";
  return suggestionAuthors(text)
    .map((a) => `${a.author ?? ""}:${a.count}`)
    .join("|");
}
