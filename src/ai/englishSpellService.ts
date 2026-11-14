/**
 * English spelling service (plan 6.10): routes a note's English paragraphs
 * to the nspell worker. Used when LanguageTool may not be reached — the
 * public API under the `local-only` policy with no LanguageTool on this
 * machine configured. The dictionary ships with the app (≈ 0.55 MB, as data
 * in the app's own dict/, precached for offline), so nothing is sent.
 */
import type { GrammarMatch } from "./grammar";
import { EN_SPELL_MESSAGE_KEY, englishSpelling, maskNonProse, type SpellChecker } from "./englishSpell";

type Result = { type: "result"; id: number; matches: GrammarMatch[] } | { type: "failed"; id: number };

let worker: Worker | null = null;
/** The worker failed (load error, crash): check on the main thread from now on. */
let broken = false;
let seq = 0;
const pending = new Map<number, { text: string; resolve: (m: GrammarMatch[]) => void }>();

let mainThread: Promise<SpellChecker> | null = null;
const mainCache = new Map<string, string[]>();

/** No worker (tests, old browsers) or the worker died: the same checker here. */
function mainThreadChecker(): Promise<SpellChecker> {
  mainThread ??= (async () => {
    const [{ default: nspell }, { loadEnglishDictionary }] = await Promise.all([import("nspell"), import("./englishDictionary")]);
    const { aff, dic } = await loadEnglishDictionary();
    return nspell(aff, dic);
  })();
  return mainThread;
}

async function checkOnMainThread(text: string): Promise<GrammarMatch[]> {
  return englishSpelling(await mainThreadChecker(), text, { suggestCache: mainCache });
}

function failWorker(): void {
  broken = true;
  worker?.terminate();
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const { text, resolve } of waiting) void checkOnMainThread(text).then(resolve, () => resolve([]));
}

function startWorker(): Worker | null {
  if (broken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL("./englishSpell.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<Result>) => {
      if (e.data.type === "failed") return failWorker();
      if (e.data.type !== "result") return;
      pending.get(e.data.id)?.resolve(e.data.matches ?? []);
      pending.delete(e.data.id);
    };
    w.onerror = () => failWorker();
    worker = w;
    return w;
  } catch {
    broken = true;
    return null;
  }
}

/** Tests: drop the worker and the main-thread checker. */
export function __resetEnglishSpell(): void {
  worker?.terminate();
  worker = null;
  broken = false;
  pending.clear();
  mainThread = null;
  mainCache.clear();
}

/** Raw check of the given text (no language routing): unknown words with suggestions. */
export async function checkEnglish(text: string): Promise<GrammarMatch[]> {
  const w = startWorker();
  const raw = w
    ? await new Promise<GrammarMatch[]>((resolve) => {
        const id = ++seq;
        pending.set(id, { text, resolve });
        w.postMessage({ type: "check", id, text });
      })
    : await checkOnMainThread(text);
  const { t } = await import("../i18n");
  return raw.map((m) => (m.message === EN_SPELL_MESSAGE_KEY ? { ...m, message: t(EN_SPELL_MESSAGE_KEY, { word: text.slice(m.offset, m.offset + m.length) }) } : m));
}

const PARAGRAPH = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;

/**
 * The text with every paragraph that is not English blanked (same length,
 * same offsets), by local language detection (plan 6.5). A paragraph too
 * short to tell follows the whole note; a note that is unclear counts as
 * English, the same fallback LanguageTool got (`en-US`).
 */
export async function englishOnly(text: string): Promise<string> {
  const { detectLanguage } = await import("../text/langId");
  // Detect on the prose only: code and URLs would sway the guess.
  const prose = maskNonProse(text);
  const whole = detectLanguage(prose);
  const noteIsEnglish = !whole.confident || whole.lang === "en";
  let out = "";
  let cursor = 0;
  for (const p of text.matchAll(PARAGRAPH)) {
    const start = p.index!;
    out += text.slice(cursor, start);
    const g = detectLanguage(prose.slice(start, start + p[0].length));
    const english = g.confident ? g.lang === "en" : noteIsEnglish;
    out += english ? p[0] : p[0].replace(/[^\n]/g, " ");
    cursor = start + p[0].length;
  }
  return out + text.slice(cursor);
}

/** English spelling for the English paragraphs of a note, on this device. */
export async function checkEnglishParagraphs(text: string): Promise<GrammarMatch[]> {
  const english = await englishOnly(text);
  return english.trim() ? checkEnglish(english) : [];
}
