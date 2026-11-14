/**
 * Citations to your own notes in "Ask the vault" answers (T29).
 *
 * The model is asked to back each claim with a source number and a short
 * verbatim quote: `[2] "the exact words"`. Here each citation is checked
 * against the note it names — the quote must really be there, word for word
 * (`quoteContained`: the prompt promises an exact quote, and an approximate
 * match would pass a quote that drops a "not") — and is
 * resolved to the line it sits on, so the answer links to note + line.
 * An answer with no verified citation is flagged as unsupported.
 */
import { quoteContained } from "../research/citations";
import { normalizeForMatch } from "../text/hebrew";

export interface VaultSource {
  path: string;
  content: string;
}

export interface VaultCitation {
  /** 1-based source number as written in the answer. */
  n: number;
  path: string | null;
  quote: string | null;
  /** 1-based line of the quote in the note, when found. */
  line: number | null;
  verified: boolean;
}

export const CITE_INSTRUCTIONS =
  'Answer only from the context files. After every claim, cite its source as [n] followed by a short exact quote from that file in double quotes, e.g. [2] "the meeting moved to Tuesday". Quote the file\'s own words (same language), at most ~20 words. If the context does not contain the answer, say so instead of guessing.';

const CITE_RE = /\[(\d{1,2})\](?:\s*[:—-]?\s*["“„«]([^"”«»\n]{3,300})["”»])?/g;

/** Every [n] (with its quote, if one follows) in order of appearance. */
export function parseVaultCitations(answer: string): Array<{ n: number; quote: string | null }> {
  const out: Array<{ n: number; quote: string | null }> = [];
  for (const m of answer.matchAll(CITE_RE)) out.push({ n: Number(m[1]), quote: m[2]?.trim() || null });
  return out;
}

/** 1-based line where `quote` starts in `content`, or null. */
export function lineOfQuote(content: string, quote: string): number | null {
  const lines = content.split("\n");
  const q = normalizeForMatch(quote);
  if (!q) return null;
  // Exact (normalised) containment on one line first, then the best line by
  // shared words — a quote may span a line break.
  for (let i = 0; i < lines.length; i++) if (normalizeForMatch(lines[i]).includes(q)) return i + 1;
  const qWords = new Set(q.split(/\s+/).filter((w) => w.length > 1));
  let best = -1;
  let bestHits = 0;
  for (let i = 0; i < lines.length; i++) {
    const hits = normalizeForMatch(lines[i]).split(/\s+/).filter((w) => qWords.has(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = i;
    }
  }
  return best >= 0 && bestHits >= Math.min(3, qWords.size) ? best + 1 : null;
}

export function verifyVaultCitations(answer: string, sources: readonly VaultSource[]): { citations: VaultCitation[]; verifiedCount: number } {
  const seen = new Set<string>();
  const citations: VaultCitation[] = [];
  for (const { n, quote } of parseVaultCitations(answer)) {
    const key = `${n}\u0000${quote ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const src = sources[n - 1];
    if (!src) {
      citations.push({ n, path: null, quote, line: null, verified: false });
      continue;
    }
    const verified = !!quote && quoteContained(quote, src.content);
    citations.push({ n, path: src.path, quote, line: quote ? lineOfQuote(src.content, quote) : null, verified });
  }
  return { citations, verifiedCount: citations.filter((c) => c.verified).length };
}

/**
 * The answer with every failed citation flagged in place, so a saved report
 * still shows which quote didn't check out after the toast is gone.
 */
export function markVaultCitations(answer: string, citations: readonly VaultCitation[]): string {
  const byKey = new Map(citations.map((c) => [`${c.n}\u0000${c.quote ?? ""}`, c]));
  return answer.replace(CITE_RE, (m: string, num: string, quote: string | undefined) => {
    const c = byKey.get(`${Number(num)}\u0000${quote?.trim() || ""}`);
    if (!c || c.verified) return m;
    if (!c.path) return `${m} ⚠️ *cites a page that wasn't given*`;
    if (!c.quote) return `${m} ⚠️ *no supporting quote given*`;
    return `${m} ⚠️ *quote not found in the page*`;
  });
}
