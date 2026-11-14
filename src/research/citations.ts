/**
 * Citation verifier (Plan D: D7): for each footnote that cites a web page,
 * check that the page is reachable and that the quoted passage really
 * appears in it. Works on any note, not only on research output.
 *
 * Footnote forms understood (one per definition line):
 *   [^1]: [Title](https://…) — “exact quote”
 *   [^2]: https://… "exact quote"
 *   [^3]: Some source, https://…            (no quote: reachability only)
 */
import { normaliseForMatch } from "../../edge-workers/research/extract";
import type { ExtractedPage } from "./client";

export interface Citation {
  id: string;
  url: string;
  title?: string;
  quote?: string;
  /** 1-based line of the definition. */
  line: number;
}

export type CitationStatus =
  | "supported"
  | "approximate"
  | "quote-not-found"
  /** Not in the part of the page that was read: the extraction hit its size cap, so absence is unknown. */
  | "not-in-excerpt"
  | "reachable"
  | "dead"
  | "unreachable";

export interface CitationCheck extends Citation {
  status: CitationStatus;
  /** HTTP status, error code or similarity, for the report. */
  detail?: string;
}

/**
 * `[title](url)` with balanced parentheses in the URL (Wikipedia-style
 * `Foo_(bar)`). `end` is just past the whole link, including an optional
 * link title (`[t](url "Official site")`), so the title isn't mistaken for
 * the quoted passage.
 */
function markdownLink(s: string): { title: string; url: string; end: number } | null {
  const m = /\[([^\]]*)\]\((https?:\/\/)/.exec(s);
  if (!m) return null;
  let i = (m.index ?? 0) + m[0].length;
  let depth = 0;
  const start = i - m[2].length;
  for (; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  const url = s.slice(start, i);
  let j = i;
  while (s[j] === " " || s[j] === "\t") j++;
  const close = ({ '"': '"', "'": "'", "(": ")" } as Record<string, string>)[s[j]];
  if (close) {
    // The title's closing delimiter, skipping backslash-escaped ones.
    let k = -1;
    for (let t = j + 1; t < s.length; t++) {
      if (s[t] === "\\") t++;
      else if (s[t] === close) {
        k = t;
        break;
      }
    }
    if (k !== -1) {
      j = k + 1;
      while (s[j] === " " || s[j] === "\t") j++;
    }
  }
  return { title: m[1], url, end: s[j] === ")" ? j + 1 : i };
}

/** A bare URL without an unbalanced trailing `)` (from surrounding prose). */
function trimUrl(u: string): string {
  let out = u;
  while (out.endsWith(")") && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1);
  return out;
}

/** The first quoted passage, closed by ITS matching delimiter (other quote marks may appear inside). */
function quotedPassage(s: string): string | undefined {
  const pairs: Record<string, string> = { "“": "”", '"': '"', "«": "»", "„": "“" };
  for (let i = 0; i < s.length; i++) {
    const close = pairs[s[i]];
    if (!close) continue;
    const end = s.indexOf(close, i + 1);
    // „…“ (German) closes with “; a straight quote closes with the last one on the line.
    const j = s[i] === '"' ? s.lastIndexOf('"') : end;
    if (j > i + 8) return s.slice(i + 1, j).trim();
  }
  return undefined;
}

/** Footnote definitions that cite an http(s) URL. Code is ignored. */
export function parseCitations(md: string): Citation[] {
  const out: Citation[] = [];
  let fence: string | null = null; // the opening run, e.g. "````"
  md.split("\n").forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      if (!fence) {
        fence = f[1];
        return;
      }
      // Closes only on the same character, at least as long, with nothing after it.
      if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) {
        fence = null;
        return;
      }
    }
    if (fence) return;
    const m = /^ {0,3}\[\^([^\]\s]+)\]:\s*(.+)$/.exec(line);
    if (!m) return;
    const rest = m[2];
    const link = markdownLink(rest);
    const bare = /(https?:\/\/[^\s>\]"”]+)/.exec(rest);
    const url = link?.url ?? (bare ? trimUrl(bare[1]) : undefined);
    if (!url) return;
    const afterUrl = link ? rest.slice(link.end) : rest.slice(rest.indexOf(url) + url.length);
    const quote = quotedPassage(afterUrl);
    out.push({ id: m[1], url: url.replace(/[.,;]+$/, ""), title: link?.title || undefined, quote, line: i + 1 });
  });
  return out;
}

const words = (s: string) => normaliseForMatch(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * How much of `quote` appears in `page`: 1 for a verbatim (normalised)
 * match, else the best share of the quote's words found in order within a
 * window of the page (tolerates small edits, ellipses, punctuation).
 */
/**
 * Is the quote really in the page, word for word? Contiguous containment
 * after normalisation (case, punctuation, Markdown marks and line breaks
 * don't matter); `...` / `…` may stand for omitted text, but each part has to
 * appear verbatim and in order. Unlike `quoteCoverage`, a dropped word fails:
 * "Alice approved" is not in "Alice never approved".
 */
export function quoteContained(quote: string, page: string): boolean {
  const parts = quote.split(/\.\.\.|…/).map(words).filter((w) => w.length);
  if (!parts.length) return false;
  const hay = ` ${words(page).join(" ")} `;
  let from = 0;
  for (const part of parts) {
    const at = hay.indexOf(` ${part.join(" ")} `, from);
    if (at < 0) return false;
    from = at + part.join(" ").length + 1;
  }
  return true;
}

export function quoteCoverage(quote: string, page: string): number {
  const q = normaliseForMatch(quote).replace(/\.\.\.|…/g, " ");
  const p = normaliseForMatch(page);
  if (q && p.includes(q)) return 1;
  const all = words(quote);
  if (all.length < 3) return 0;
  const pw = words(page);
  // Bounded work: a long quote is matched as up to 5 segments of 200 words
  // spread over its whole length (head and tail always included), so a
  // fabricated tail lowers the score and a one-word difference doesn't.
  const SEG = SAMPLE_WORDS;
  const segs: Array<{ words: string[]; offset: number }> = [];
  if (all.length <= SEG) segs.push({ words: all, offset: 0 });
  else {
    const n = Math.min(5, Math.ceil(all.length / SEG));
    for (let k = 0; k < n; k++) {
      const at = Math.round(((all.length - SEG) * k) / Math.max(1, n - 1));
      segs.push({ words: all.slice(at, at + SEG), offset: at });
    }
  }
  // The segments must come from one passage, in order: each one's page
  // position has to follow the previous one's by about the same distance
  // as in the quote; a segment found elsewhere counts as unmatched.
  let matched = 0;
  let compared = 0;
  let prev: { at: number; offset: number } | null = null;
  for (const seg of segs) {
    const m = matchSegment(seg.words, pw);
    compared += seg.words.length;
    const gap = prev ? seg.offset - prev.offset : 0;
    const ok = !prev || (m.at - prev.at >= gap * 0.7 - 5 && m.at - prev.at <= gap * 1.3 + 10);
    if (ok && m.matched) {
      matched += m.matched;
      prev = { at: m.at, offset: seg.offset };
    }
  }
  return matched / compared;
}

/**
 * Words of `qw` matched IN ORDER somewhere in the page (best alignment).
 * For each start in the page where one of the segment's opening words
 * occurs, match its words in order from that word on within a window
 * (skipping up to a few extra or missing words). A passage with the same
 * words in another order doesn't count. Starts reach past the first few
 * words so a quote whose opening words were dropped can still reach the
 * approximate threshold (the dropped words count as missed). Each opening
 * word starts at most 2 alignments, and candidate starts are sampled evenly
 * across the page when there are too many (the check runs on the UI thread).
 */
function matchSegment(qw: string[], pw: string[]): { matched: number; at: number } {
  if (!qw.length) return { matched: 0, at: 0 };
  const win = Math.ceil(qw.length * 1.3) + 2;
  const lead = Math.max(3, Math.ceil(qw.length * (1 - APPROXIMATE_AT)) + 1);
  const starts = new Map<string, number[]>(); // word → its indexes among the opening words
  qw.slice(0, lead).forEach((w, s) => {
    const at = starts.get(w) ?? [];
    if (at.length < 2) starts.set(w, [...at, s]);
  });
  let cand: number[] = [];
  for (let i = 0; i < pw.length; i++) if (starts.has(pw[i])) cand.push(i);
  const MAX_CANDIDATES = Math.max(50, Math.floor(800_000 / (win * 6)));
  if (cand.length > MAX_CANDIDATES) {
    const step = cand.length / MAX_CANDIDATES;
    cand = Array.from({ length: MAX_CANDIDATES }, (_, k) => cand[Math.floor(k * step)]);
  }
  let best = 0;
  let bestAt = 0;
  for (const i of cand) {
    if (best >= qw.length) break;
    for (const s of starts.get(pw[i]) ?? []) {
      let q = s;
      let matched = 0;
      for (let j = i; j < Math.min(pw.length, i + win) && q < qw.length; j++) {
        // Find pw[j] among the next few quote words (tolerates a dropped word).
        for (let k = q; k < Math.min(qw.length, q + 3); k++) {
          if (qw[k] === pw[j]) {
            matched++;
            q = k + 1;
            break;
          }
        }
      }
      if (matched > best) {
        best = matched;
        bestAt = i - s; // where the segment's first word would sit on the page
      }
    }
  }
  return { matched: best, at: bestAt };
}

export const APPROXIMATE_AT = 0.85;
/** Quotes longer than this many words are scored on up to 5 samples of this size (A7). */
export const SAMPLE_WORDS = 200;

/** Check every citation; `fetchPage` is the research client's extractPage (injected for tests). */
export async function verifyCitations(
  citations: readonly Citation[],
  fetchPage: (url: string) => Promise<ExtractedPage>,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<CitationCheck[]> {
  const out: CitationCheck[] = new Array(citations.length);
  const pages = new Map<string, Promise<ExtractedPage>>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < citations.length) {
      const i = next++;
      const c = citations[i];
      let page = pages.get(c.url);
      if (!page) pages.set(c.url, (page = fetchPage(c.url)));
      const p = await page;
      let check: CitationCheck;
      if (p.error === "http-error") check = { ...c, status: "dead", detail: `HTTP ${p.status}` };
      else if (p.error || !p.text) check = { ...c, status: "unreachable", detail: p.error ?? "empty page" };
      else if (!c.quote) check = { ...c, status: "reachable" };
      else {
        const cov = quoteCoverage(c.quote, p.text);
        // "Supported" means word for word (A7): a long quote is scored on
        // samples, so a full score there is only an approximate match.
        const sampled = words(c.quote).length > SAMPLE_WORDS;
        check =
          cov === 1 && quoteContained(c.quote, p.text)
            ? { ...c, status: "supported" }
            : cov >= APPROXIMATE_AT
              ? { ...c, status: "approximate", detail: sampled ? `${Math.round(cov * 100)}% of the sampled words (long quote, checked on samples)` : `${Math.round(cov * 100)}% of the words` }
              : p.truncated
                ? // Only the start of a long page was read: the passage may be further down.
                  { ...c, status: "not-in-excerpt", detail: `best match ${Math.round(cov * 100)}% in the part read` }
                : { ...c, status: "quote-not-found", detail: `best match ${Math.round(cov * 100)}%` };
      }
      out[i] = check;
      opts.onProgress?.(++done, citations.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, citations.length) }, worker));
  return out;
}

const ICON: Record<CitationStatus, string> = {
  supported: "✅",
  approximate: "🟡",
  reachable: "🔗",
  "quote-not-found": "❌",
  "not-in-excerpt": "❔",
  dead: "💀",
  unreachable: "⚠️",
};
const LABEL: Record<CitationStatus, string> = {
  supported: "quote found",
  approximate: "quote found approximately",
  reachable: "page reachable (no quote to check)",
  "quote-not-found": "quote NOT found on the page",
  "not-in-excerpt": "quote not found in the part of the page that was read (page too long to check fully)",
  dead: "dead link",
  unreachable: "couldn't read the page",
};

/** Markdown report of a citation check. */
export function formatCitationReport(docName: string, checks: readonly CitationCheck[], now = new Date()): string {
  const count = (s: CitationStatus) => checks.filter((c) => c.status === s).length;
  const problems = count("quote-not-found") + count("not-in-excerpt") + count("dead") + count("unreachable");
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# Citation check — ${docName}`,
    "",
    `${checks.length} citations checked on ${now.toISOString().slice(0, 10)}: ${count("supported") + count("approximate")} quotes found, ${count("reachable")} reachable without a quote, **${problems} to look at**.`,
    "",
  ];
  if (!checks.length) {
    lines.push("No footnotes with web links found. Footnotes look like `[^1]: [Title](https://…) — “quoted passage”`.");
    return lines.join("\n");
  }
  lines.push("| | Footnote | Line | Source | Result |", "|---|---|---:|---|---|");
  const order: CitationStatus[] = ["quote-not-found", "dead", "unreachable", "not-in-excerpt", "approximate", "reachable", "supported"];
  for (const c of [...checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))) {
    let host = c.url;
    try {
      host = new URL(c.url).hostname;
    } catch {
      /* malformed: show it as written */
    }
    const src = `[${esc(c.title || host)}](${c.url})`;
    lines.push(`| ${ICON[c.status]} | \`[^${esc(c.id)}]\` | ${c.line} | ${src} | ${LABEL[c.status]}${c.detail ? ` (${esc(c.detail)})` : ""} |`);
  }
  return lines.join("\n");
}
