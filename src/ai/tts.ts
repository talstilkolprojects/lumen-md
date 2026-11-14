/**
 * Read a note aloud (T32) with the system's own voices (Web Speech API) —
 * on macOS / Windows / Android that includes Hebrew. Some browsers also list
 * voices that synthesize on a server (Chrome's "Google …" voices send the
 * text out): those are used only under the `cloud` AI policy (plan 6.17);
 * otherwise only voices with `localService` speak. Text is spoken sentence by sentence; each sentence's range in the
 * document is reported so the editor can highlight what is being read.
 */
import { hebrewRatio } from "../text/hebrew";
import { thirdPartyServicesAllowed } from "./policy";
import { addSpeechVoiceBytes, recordSpeechVoice } from "./privacyLedger";

/** Opt-in for voices that synthesize on a server (Chrome's "Google …" voices send the text out). */
export const NETWORK_VOICES_KEY = "lumen.tts.networkVoices";

/** The opt-in for this page session, kept even when storage refuses to save it. */
let sessionOptIn = false;

/** May a voice that is not `localService` be used? Only under the `cloud` policy (plan 6.17), and only after opt-in. */
export function networkVoicesAllowed(): boolean {
  if (!thirdPartyServicesAllowed()) return false;
  if (sessionOptIn) return true;
  try {
    return localStorage.getItem(NETWORK_VOICES_KEY) === "1";
  } catch {
    // why: storage blocked (private mode) — only this session's opt-in counts
    return false;
  }
}

export interface Sentence {
  text: string;
  from: number;
  to: number;
}

/** Source ranges of fenced code blocks — ``` and ~~~ fences; an unclosed one runs to the end. */
function fencedRanges(markdown: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: { start: number; char: string; len: number } | null = null;
  let pos = 0;
  for (const line of markdown.split("\n")) {
    const end = pos + line.length + 1;
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ""));
    if (open) {
      if (m && m[1][0] === open.char && m[1].length >= open.len && !m[2].trim()) {
        out.push([open.start, Math.min(end, markdown.length)]);
        open = null;
      }
    } else if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { start: pos, char: m[1][0], len: m[1].length };
    }
    pos = end;
  }
  if (open) out.push([open.start, markdown.length]);
  return out;
}

/** Markdown → speakable sentences with their source ranges. */
export function speakableSentences(markdown: string): Sentence[] {
  const out: Sentence[] = [];
  // Skip frontmatter and fenced code: nobody wants code read aloud.
  const skip: Array<[number, number]> = [];
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (fm) skip.push([0, fm[0].length]);
  skip.push(...fencedRanges(markdown));
  const inSkip = (i: number) => skip.some(([a, b]) => i >= a && i < b);
  // A sentence ends at . ! ? followed by whitespace — "x.y" (URLs, 3.5) doesn't.
  const re = /[^.!?。؟\n]+(?:[.!?。؟]+(?=[^\s.!?。؟])[^.!?。؟\n]*)*[.!?。؟]*/g;
  for (const m of markdown.matchAll(re)) {
    const from = m.index!;
    if (inSkip(from)) continue;
    const text = m[0]
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_a, t, alias) => alias ?? t)
      .replace(/[#>*_`~|-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/[\p{L}\p{N}]/u.test(text)) out.push({ text, from, to: from + m[0].length });
  }
  return out;
}

type Detect = (text: string) => { lang: string; confident: boolean; script: string | null };
const voiceTag = (lang: string) => (lang === "he" ? "he-IL" : lang);

/** The script a language is written in (for the languages the detector reports); Latin otherwise. */
const SCRIPT_OF_LANG: Record<string, string> = { he: "hebrew", yi: "hebrew", ar: "arabic", fa: "arabic", ur: "arabic", ps: "arabic", ru: "cyrillic", uk: "cyrillic", be: "cyrillic", bg: "cyrillic", sr: "cyrillic", kk: "cyrillic", ja: "kana", zh: "han", ko: "hangul", el: "greek", th: "thai", hi: "devanagari", mr: "devanagari", ne: "devanagari" };
const scriptOfLang = (tag: string) => SCRIPT_OF_LANG[tag.split(/[-_]/)[0].toLowerCase()] ?? "latin";

/** UI languages whose own script is not Latin: a Latin-script sentence there is not in the UI language. */
const NON_LATIN_UI = /^(he|iw|ar|ja|zh|ru|uk|el|ko|hi|th)\b/i;

/**
 * BCP-47 language for a sentence, from its script: Hebrew → he-IL, Arabic →
 * ar, Cyrillic → ru, kana → ja, Han → zh-CN (ja under a Japanese UI). Latin
 * script takes the UI language when that language is written in Latin
 * script, and English otherwise — so an English note under a Hebrew UI asks
 * for an English voice, not a Hebrew one.
 *
 * With the local detector (plan 6.5): a language it is sure of; for a short
 * or unclear sentence, the document's language (`fallback`) when that is
 * written in the sentence's script — a short Latin or Cyrillic sentence takes
 * the document's voice, kanji inside a Japanese document stay Japanese — and
 * otherwise the detector's best guess for the script, so a short Arabic,
 * Hebrew, kana, Han, Hangul, Greek or Thai sentence under an English
 * document is never read with the English voice.
 */
export function langFor(text: string, fallback: string, detect?: Detect): string {
  if (hebrewRatio(text) > 0.3) return "he-IL";
  if (detect) {
    const g = detect(text);
    if (g.lang === "und" || !g.script) return fallback;
    const docScript = scriptOfLang(fallback);
    const docCovers = docScript === g.script || (docScript === "kana" && g.script === "han");
    if (docCovers && (!g.confident || g.script === "han")) return fallback;
    return g.confident || !docCovers ? voiceTag(g.lang) : fallback;
  }
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[\u3040-\u30FF]/.test(text)) return "ja";
  if (/[\u4E00-\u9FFF]/.test(text)) return /^ja\b/i.test(fallback) ? "ja" : "zh-CN";
  if (/[\u0400-\u04FF]/.test(text)) return /^(ru|uk|bg|sr)\b/i.test(fallback) ? fallback : "ru";
  if (/[A-Za-z\u00C0-\u024F]/.test(text) && NON_LATIN_UI.test(fallback)) return "en";
  return fallback;
}

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function allowNetworkVoices(): void {
  sessionOptIn = true;
  try {
    localStorage.setItem(NETWORK_VOICES_KEY, "1");
  } catch {
    // why: storage blocked — sessionOptIn keeps the opt-in until reload
  }
}

/**
 * The browser's voice list. It is often empty on a fresh page until
 * `voiceschanged` fires, so wait for that (or `timeoutMs`) before deciding a
 * voice is missing.
 */
export function voicesReady(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!ttsAvailable()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener?.("voiceschanged", done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    synth.addEventListener?.("voiceschanged", done);
  });
}

/** Does the browser list any voice that synthesizes on a server? */
export function offersNetworkVoices(): boolean {
  return ttsAvailable() && window.speechSynthesis.getVoices().some((v) => !v.localService);
}

/** Is there an on-device voice for every language the note's sentences need? */
export function hasLocalVoiceFor(markdown: string, uiLang: string): boolean {
  if (!ttsAvailable()) return false;
  const langs = new Set(speakableSentences(markdown).map((s) => langFor(s.text, uiLang === "he" ? "he-IL" : uiLang)));
  return [...langs].every((l) => voiceFor(l, false));
}

/** Best voice for `lang`; network voices only when `allowNetwork`. Exported for tests. */
export function voiceFor(lang: string, allowNetwork = networkVoicesAllowed()): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => allowNetwork || v.localService);
  const base = lang.split("-")[0].toLowerCase();
  return voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ?? voices.find((v) => v.lang.toLowerCase().startsWith(base)) ?? (base === "he" ? voices.find((v) => v.lang.toLowerCase().startsWith("iw")) : undefined);
}

let speaking = false;
/** Bumped by every stop: a reading whose run is no longer current stops at its next step. */
let currentRun = 0;

export function isSpeaking(): boolean {
  return speaking;
}

/** Test hook. */
export function __resetTts(): void {
  sessionOptIn = false;
  speaking = false;
  currentRun = 0;
}

export function stopSpeaking(): void {
  speaking = false;
  currentRun++;
  if (ttsAvailable()) window.speechSynthesis.cancel();
}

/**
 * Claim read-aloud for a new reading before anything is awaited: stops an
 * earlier reading, and `isSpeaking()` is true from here on. So a second "Read
 * aloud" while the voice list loads or the opt-in prompt is open stops this
 * reading instead of starting a second one. Pass the run to `speak()`.
 */
export function beginSpeaking(): number {
  stopSpeaking();
  speaking = true;
  return currentRun;
}

/** Is `run` still the reading in progress (not stopped, not replaced by a newer one)? */
export function isCurrentRun(run: number): boolean {
  return speaking && run === currentRun;
}

/**
 * Speak `markdown`. `onSentence` gets each sentence as it starts; resolves
 * when done or stopped. Returns false when a needed voice is missing — under
 * local-only (or without the opt-in) only voices that run on this device count.
 * A network voice, when allowed, is recorded in the privacy ledger.
 */
export async function speak(markdown: string, opts: { uiLang: string; rate?: number; onSentence?: (s: Sentence) => void; run?: number }): Promise<boolean> {
  if (!ttsAvailable()) return false;
  // A run claimed with beginSpeaking() and stopped meanwhile speaks nothing.
  if (opts.run !== undefined && !isCurrentRun(opts.run)) return true;
  const run = opts.run ?? beginSpeaking();
  try {
    const sentences = speakableSentences(markdown);
    if (!sentences.length) return true;
    await voicesReady();
    // Local language detection (plan 6.5): each sentence gets the voice of
    // its own language; short or unclear ones the document's language.
    let detect: Detect | undefined;
    try {
      detect = (await import("../text/langId")).detectLanguage;
    } catch {
      detect = undefined;
    }
    // A newer reading or a stop while the detector loaded: this run is over.
    if (!isCurrentRun(run)) return true;
    const ui = opts.uiLang === "he" ? "he-IL" : opts.uiLang;
    const whole = detect?.(sentences.map((x) => x.text).join(" "));
    const docLang = whole && whole.confident && whole.lang !== "und" ? voiceTag(whole.lang) : ui;
    let hadVoice = true;
    const allowNetwork = networkVoicesAllowed();
    /** Ledger entry per network voice; every sentence sent through it adds its UTF-8 size. */
    const logged = new Map<string, number>();
    const utf8 = new TextEncoder();
    for (const s of sentences) {
      // why: a stop, or a newer reading, ends this one — two readings never interleave
      if (!isCurrentRun(run)) break;
      const lang = langFor(s.text, docLang, detect);
      const u = new SpeechSynthesisUtterance(s.text);
      u.lang = lang;
      const v = voiceFor(lang, allowNetwork);
      if (!v) {
        // A missing local voice: say so instead of letting the browser pick a network one.
        hadVoice = false;
        continue;
      }
      u.voice = v;
      if (!v.localService) {
        const bytes = utf8.encode(s.text).length;
        const id = logged.get(v.name);
        // why: the ledger may have been cleared (or the entry evicted) mid-reading — start a new entry then
        if (id === undefined || !addSpeechVoiceBytes(id, bytes)) {
          const entry = recordSpeechVoice(v.name, lang, bytes);
          if (entry) logged.set(v.name, entry.id);
        }
      }
      u.rate = opts.rate ?? 1;
      opts.onSentence?.(s);
      await new Promise<void>((resolve) => {
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      });
    }
    return hadVoice;
  } finally {
    if (run === currentRun) speaking = false;
  }
}
