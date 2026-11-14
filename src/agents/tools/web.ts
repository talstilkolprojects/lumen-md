/**
 * Web tools — search and read pages through the research service (a local
 * SearXNG + extractor, or the research worker), never by fetching a
 * cross-origin page from the browser. `search_web` and `fetch_page` have
 * scope `network`: the runtime's gate (`../network.ts`) applies the AI
 * policy and the per-call consent, and hands them a fetch the privacy
 * ledger records. Only the query or the page address is sent — never the
 * document.
 *
 * `extract_quotes` is local: it checks quotes word for word against a
 * page read in this run (or the open document / a workspace file) and
 * returns their exact text and offsets, so a citation can point at the
 * source.
 */

import { defineTool, networkBinding, networkFetch, optionalNumber, requireString, safeWorkspacePath, throwIfAborted, ToolError } from "./define";
import { quoteContained } from "../../research/citations";

const PAGE_LIMIT = 12_000;

export const searchWebTool = defineTool<
  { query: string; count?: number },
  { query: string; provider: string; results: Array<{ title: string; url: string; snippet: string }> }
>({
  name: "search_web",
  description: "Search the web (through the research service: SearXNG, Brave or Tavily). Only the query is sent. Returns titles, URLs and snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 400 },
      count: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  scope: "network",
  // Titles and snippets are written by the pages' authors.
  untrusted: (args, result) => (result.results.length ? [`web search results for "${args.query}"`] : []),
  run: async (args, ctx) => {
    const fetchImpl = networkFetch(ctx, "search_web");
    const query = requireString(args, "query").trim().slice(0, 400);
    const count = Math.min(10, Math.max(1, Math.round(optionalNumber(args, "count", 5))));
    // The service and settings the call was approved with, not as they are now (review on #205).
    const { endpoint, settings } = networkBinding(ctx, "search_web");
    const { searchWeb } = await import("../../research/client");
    // Claude web search is a server-side tool of the Anthropic API (research.ask's cloud route), not a search the agent can call.
    if (settings.provider === "claude") throw new ToolError("failed", "Web search is set to Claude (a cloud route); pick SearXNG, Brave or Tavily in Research: Settings for agent searches");
    try {
      const results = await searchWeb(query, settings, count, ctx.signal, endpoint, fetchImpl);
      return { query, provider: settings.provider, results: results.slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })) };
    } catch (e) {
      if (ctx.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
      throw new ToolError("failed", (e as Error)?.message ?? String(e));
    }
  },
});

export const fetchPageTool = defineTool<
  { url: string; maxChars?: number },
  { url: string; finalUrl: string; status: number; title?: string; text: string; truncated: boolean; error?: string }
>({
  name: "fetch_page",
  description: "Read a web page as plain text (through the research service, which fetches it). Only the address is sent. Quote from it with extract_quotes.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", pattern: "^https?://", maxLength: 2000 },
      maxChars: { type: "integer", minimum: 200, maximum: PAGE_LIMIT },
    },
    required: ["url"],
    additionalProperties: false,
  },
  scope: "network",
  untrusted: (_args, result) => (result.text || result.title ? [`web page ${result.finalUrl}`] : []),
  run: async (args, ctx) => {
    const fetchImpl = networkFetch(ctx, "fetch_page");
    const url = requireString(args, "url").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw new ToolError("bad-args", "Only http(s) addresses can be read");
    const max = Math.min(PAGE_LIMIT, Math.max(200, optionalNumber(args, "maxChars", PAGE_LIMIT)));
    const { endpoint } = networkBinding(ctx, "fetch_page");
    const { extractPage } = await import("../../research/client");
    const page = await extractPage(url, ctx.signal, endpoint, fetchImpl);
    throwIfAborted(ctx.signal);
    if (page.error) return { url, finalUrl: page.finalUrl, status: page.status, text: "", truncated: false, error: page.error };
    const text = page.text ?? "";
    // The whole text stays in the run so extract_quotes can quote beyond what the model was shown.
    ctx.pages?.set(url, { url, finalUrl: page.finalUrl, title: page.title, text });
    if (page.finalUrl !== url) ctx.pages?.set(page.finalUrl, { url, finalUrl: page.finalUrl, title: page.title, text });
    return {
      url,
      finalUrl: page.finalUrl,
      status: page.status,
      ...(page.title ? { title: page.title } : {}),
      text: text.slice(0, max),
      truncated: text.length > max || !!page.truncated,
    };
  },
});

/* ─── extract_quotes ─────────────────────────────────────────────────── */

export interface QuoteMatch {
  quote: string;
  found: boolean;
  /** The source text the quote matched, verbatim (original case, punctuation and line breaks). */
  exact?: string;
  /** UTF-16 offsets of `exact` in the source: [start, end). */
  start?: number;
  end?: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
const fold = (w: string) => w.toLowerCase();

/**
 * Locate a quote that `quoteContained` accepted: the first run of source
 * words equal to the quote's words (an ellipsis may skip text between
 * parts), mapped back to offsets in the original text.
 */
export function locateQuote(quote: string, source: string): { start: number; end: number } | null {
  const tokens = [...source.matchAll(WORD)].map((m) => ({ w: fold(m[0]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const parts = quote
    .split(/\.\.\.|…/)
    .map((p) => (p.match(WORD) ?? []).map(fold))
    .filter((p) => p.length);
  if (!parts.length) return null;
  const findRun = (part: string[], from: number): number => {
    outer: for (let i = from; i + part.length <= tokens.length; i++) {
      for (let j = 0; j < part.length; j++) if (tokens[i + j].w !== part[j]) continue outer;
      return i;
    }
    return -1;
  };
  for (let first = findRun(parts[0], 0); first >= 0; first = findRun(parts[0], first + 1)) {
    let at = first + parts[0].length;
    let ok = true;
    for (const part of parts.slice(1)) {
      const i = findRun(part, at);
      if (i < 0) {
        ok = false;
        break;
      }
      at = i + part.length;
    }
    if (ok) return { start: tokens[first].start, end: tokens[at - 1].end };
  }
  return null;
}

export function extractQuotes(quotes: string[], source: string): QuoteMatch[] {
  return quotes.map((quote) => {
    if (!quoteContained(quote, source)) return { quote, found: false };
    const loc = locateQuote(quote, source);
    return loc ? { quote, found: true, exact: source.slice(loc.start, loc.end), ...loc } : { quote, found: true };
  });
}

export const extractQuotesTool = defineTool<
  { quotes: string[]; url?: string; path?: string },
  { source: string; quotes: QuoteMatch[]; found: number }
>({
  name: "extract_quotes",
  description:
    "Check quotes word for word against a source and return each one's exact text and character offsets. Source: a page read " +
    "with fetch_page in this run (url), a workspace file (path), or the open document (neither). `...` may stand for omitted words. " +
    "A quote that is not in the source comes back found=false — do not cite it.",
  parameters: {
    type: "object",
    properties: {
      quotes: { type: "array", items: { type: "string", minLength: 1, maxLength: 2000 }, minItems: 1, maxItems: 20 },
      url: { type: "string", description: "A page fetched with fetch_page in this run" },
      path: { type: "string", description: "A workspace file" },
    },
    required: ["quotes"],
    additionalProperties: false,
  },
  // The quotes' exact text comes from the source.
  untrusted: async (args, result, ctx) => {
    if (typeof args.url === "string" && args.url.trim()) return [`web page ${result.source}`];
    const { untrustedSourcesOfNote } = await import("../untrusted");
    if (typeof args.path === "string" && args.path.trim()) {
      const { readWorkspaceFile } = await import("../../storage/workspace");
      return untrustedSourcesOfNote(result.source, await readWorkspaceFile(result.source).catch(() => null));
    }
    return ctx.documentUntrusted ?? [];
  },
  run: async (args, ctx) => {
    const quotes = Array.isArray(args.quotes) ? args.quotes.filter((q): q is string => typeof q === "string" && !!q.trim()).slice(0, 20) : [];
    if (!quotes.length) throw new ToolError("bad-args", '"quotes" must be a non-empty array of strings');
    let source: string;
    let label: string;
    if (typeof args.url === "string" && args.url.trim()) {
      const page = ctx.pages?.get(args.url.trim());
      if (!page) throw new ToolError("not-found", `No page ${args.url} was read in this run — call fetch_page first`);
      source = page.text;
      label = page.finalUrl;
    } else if (typeof args.path === "string" && args.path.trim()) {
      const path = safeWorkspacePath(args.path);
      const { readWorkspaceFile } = await import("../../storage/workspace");
      try {
        source = await readWorkspaceFile(path);
      } catch {
        throw new ToolError("not-found", `No such file: ${path}`);
      }
      label = path;
    } else {
      if (ctx.document === undefined) throw new ToolError("bad-args", 'No document is open: pass "url" or "path"');
      source = ctx.document;
      label = ctx.path ?? "document";
    }
    throwIfAborted(ctx.signal);
    const matches = extractQuotes(quotes, source);
    return { source: label, quotes: matches, found: matches.filter((m) => m.found).length };
  },
});

export const WEB_TOOLS = [searchWebTool, fetchPageTool, extractQuotesTool];
