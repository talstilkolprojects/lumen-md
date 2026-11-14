import { fetchWithRetry } from "../lib/fetchRetry";
import { cloudAllowed, isLocalOrigin, thirdPartyServicesAllowed } from "./policy";
import { connectAllowedByCsp } from "../lib/cspConnect";

/**
 * LanguageTool grammar checker — a thin client that hits the public
 * `https://api.languagetool.org/v2/check` endpoint. Returns the raw matches
 * so the editor can render squiggle decorations or surface a summary.
 *
 * The free tier rate-limits anonymous requests, so callers should debounce
 * (e.g. 1.5s after the user stops typing) and skip very short documents.
 *
 * Self-host: run LanguageTool locally (docker/local-ai.yml, port 8010) and set
 * the endpoint at run time (`lumen.grammar.endpoint`, CSP-checked) or at
 * build time (`VITE_LANGUAGETOOL_URL`). When no LanguageTool on this machine
 * is configured and the AI policy keeps the public API off limits, an
 * English paragraphs are spell-checked on this device instead (nspell,
 * plan 6.10), and an explicit check (`{ allowModel: true }`) adds the
 * local `proofreader` agent.
 */

export interface GrammarMatch {
  /** 0-based UTF-16 offset into the input. */
  offset: number;
  length: number;
  /** Short human description of the suggested fix. */
  message: string;
  /** Up to a few suggested replacements — usually present, sometimes empty. */
  replacements: string[];
  rule: { id: string; category?: string };
}

const DEFAULT_URL = "https://api.languagetool.org/v2/check";
const RECENT: Map<string, GrammarMatch[]> = new Map();
const RECENT_LIMIT = 16;

/** Every cache write goes through here, so the size limit holds on every path. */
function remember(key: string, matches: GrammarMatch[]): void {
  RECENT.delete(key);
  while (RECENT.size >= RECENT_LIMIT) {
    const oldest = RECENT.keys().next().value;
    if (oldest === undefined) break;
    RECENT.delete(oldest);
  }
  RECENT.set(key, matches);
}

/** Tests. */
export function __grammarCacheSize(): number {
  return RECENT.size;
}

export const GRAMMAR_ENDPOINT_KEY = "lumen.grammar.endpoint";

export function grammarEndpoint(): string {
  try {
    const stored = localStorage.getItem(GRAMMAR_ENDPOINT_KEY);
    if (stored && connectAllowedByCsp(stored)) return stored;
  } catch {
    /* why: storage denied */
  }
  const env = (
    import.meta as ImportMeta & { env?: { VITE_LANGUAGETOOL_URL?: string } }
  ).env?.VITE_LANGUAGETOOL_URL;
  return env || DEFAULT_URL;
}

const endpoint = grammarEndpoint;

/** LanguageTool codes for the languages local detection reports. */
const LT_CODES: Record<string, string> = { en: "en-US", de: "de-DE", fr: "fr", ru: "ru-RU", uk: "uk-UA", ar: "ar", fa: "fa", ja: "ja-JP", zh: "zh-CN", es: "es", it: "it", pt: "pt-PT", nl: "nl", pl: "pl-PL", el: "el-GR" };

/**
 * The LanguageTool language of a text, detected on this device (plan 6.5).
 * The old fixed `en-US` flagged every word of a French or German note;
 * unclear or unsupported text keeps `en-US`.
 */
export async function grammarLanguage(text: string, fallback = "en-US"): Promise<string> {
  try {
    const { detectLanguage } = await import("../text/langId");
    const g = detectLanguage(text);
    return (g.confident && LT_CODES[g.lang]) || fallback;
  } catch {
    return fallback;
  }
}

/** May a check go to `url`, which is not on this machine or network? */
function remoteGrammarAllowed(url: string): boolean {
  return url === DEFAULT_URL ? thirdPartyServicesAllowed() : cloudAllowed();
}

/** Grammar through the local proofreader agent: issues mapped to LanguageTool-shaped matches. */
async function checkWithModel(text: string, language: string, signal?: AbortSignal): Promise<GrammarMatch[]> {
  const { runAgentOrThrow } = await import("../agents/runtime");
  const { proofreaderAgent, locateIssues, PROOF_MAX_CHARS } = await import("../agents/defs");
  const slice = text.slice(0, PROOF_MAX_CHARS);
  const out = await runAgentOrThrow(proofreaderAgent, { text: slice, extra: { language } }, { document: text, signal });
  return locateIssues(out.issues, slice).map((i) => ({ ...i, rule: { id: "LOCAL_MODEL", category: "local" } }));
}

/** `first`, then every match of `second` that does not overlap one of them, by offset. */
export function mergeMatches(first: GrammarMatch[], second: GrammarMatch[]): GrammarMatch[] {
  const overlaps = (a: GrammarMatch, b: GrammarMatch) => a.offset < b.offset + b.length && b.offset < a.offset + a.length;
  const extra = second.filter((m) => !first.some((f) => overlaps(f, m)));
  return [...first, ...extra].sort((a, b) => a.offset - b.offset);
}

/**
 * Check `text` for grammar/spelling/style issues. Empty / very short inputs
 * return immediately with no matches — LanguageTool isn't useful below ~10
 * words and the public endpoint penalises us for hammering it.
 */
export async function checkGrammar(
  text: string,
  language = "en-US",
  opts: { allowModel?: boolean; signal?: AbortSignal } = {},
): Promise<GrammarMatch[]> {
  const trimmed = text.trim();
  if (trimmed.length < 40) return [];
  const cacheKey = `${language}\n${trimmed}`;
  const cached = RECENT.get(cacheKey);
  if (cached) return cached;
  // A self-hosted LanguageTool on this machine or network is fine under
  // every policy. A remote one the user configured counts as their cloud
  // choice outside local-only; the public API nobody configured needs the
  // explicit `cloud` policy (plan 6.17).
  // Without it: English spelling on this device (plan 6.10), plus the
  // proofreader model when the user asked for a check.
  if (!isLocalOrigin(endpoint()) && !remoteGrammarAllowed(endpoint())) {
    const { checkEnglishParagraphs } = await import("./englishSpellService");
    const spelling = await checkEnglishParagraphs(trimmed).catch(() => [] as GrammarMatch[]);
    const matches = opts.allowModel ? mergeMatches(spelling, await checkWithModel(trimmed, language, opts.signal)) : spelling;
    remember(cacheKey, matches);
    return matches;
  }

  const body = new URLSearchParams({
    text: trimmed,
    language,
    enabledOnly: "false",
  });
  const res = await fetchWithRetry(
    endpoint(),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: opts.signal,
    },
    {
      label: "grammar.check",
      maxRetries: 2,
      baseDelayMs: 600,
      maxDelayMs: 2000,
    },
  );
  if (!res.ok) {
    throw new Error(`LanguageTool ${res.status}`);
  }
  const json = (await res.json()) as {
    matches: Array<{
      offset: number;
      length: number;
      message: string;
      replacements?: { value: string }[];
      rule: { id: string; category?: { id?: string } };
    }>;
  };
  const matches: GrammarMatch[] = json.matches.map((m) => ({
    offset: m.offset,
    length: m.length,
    message: m.message,
    replacements: (m.replacements ?? []).map((r) => r.value).slice(0, 5),
    rule: { id: m.rule.id, category: m.rule.category?.id },
  }));

  // Tiny LRU.
  remember(cacheKey, matches);
  return matches;
}

export function clearGrammarCache(): void {
  RECENT.clear();
}
