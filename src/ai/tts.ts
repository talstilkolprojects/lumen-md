/**
 * Read a note aloud (T32) with the system's own voices (Web Speech API) —
 * on macOS / Windows / Android that includes Hebrew. Some browsers also list
 * voices that synthesize on a server (Chrome's "Google …" voices send the
 * text out): those are used only under the `cloud` AI policy (plan 6.17);
 * otherwise only voices with `localService` speak. Text is spoken sentence by sentence; each sentence's range in the
 * document is reported so the editor can highlight what is being read.
 *
 * W2.6 also keeps the reading position per note (run again → it resumes; at
 * the end it starts over), and a voice per language chosen in *Read aloud:
 * voice and speed* (the speed is the reading aids' one, plan W5.6). A neural
 * Hebrew voice (./tts/) is used only when a licensed one is installed — none
 * exists yet (decision 15.10).
 */
import "./ttsStrings";
import { hebrewRatio } from "../text/hebrew";
import { log } from "../lib/logger";
import { thirdPartyServicesAllowed } from "./policy";
import { addSpeechVoiceBytes, recordSpeechVoice } from "./privacyLedger";
import { mapSpokenWords, wordAtChar } from "../reading/wordSync";

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

/**
 * Best voice for `lang`; network voices only when `allowNetwork`. `chosen`
 * (a voiceURI from the settings, W2.6) wins when it is allowed and speaks
 * that language. Exported for tests.
 */
export function voiceFor(lang: string, allowNetwork = networkVoicesAllowed(), chosen?: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => allowNetwork || v.localService);
  const base = lang.split("-")[0].toLowerCase();
  const pick = chosen ? voices.find((v) => v.voiceURI === chosen && v.lang.toLowerCase().split("-")[0].replace("iw", "he") === base) : undefined;
  return pick ?? voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ?? voices.find((v) => v.lang.toLowerCase().startsWith(base)) ?? (base === "he" ? voices.find((v) => v.lang.toLowerCase().startsWith("iw")) : undefined);
}

export interface WordRange {
  from: number;
  to: number;
  /** Where the word starts in the spoken (cleaned) sentence text. */
  at: number;
}

/**
 * The spoken sentence's words mapped back to the note: each word of the
 * cleaned text found, in order, in the sentence's source (links and marks
 * were removed, so positions differ). A word that cannot be found is skipped.
 */
export function wordRanges(source: string, sentence: Sentence): WordRange[] {
  const src = source.slice(sentence.from, sentence.to);
  const out: WordRange[] = [];
  let cursor = 0;
  for (const m of sentence.text.matchAll(/[\p{L}\p{M}\p{N}'׳״"]+/gu)) {
    const i = src.indexOf(m[0], cursor);
    if (i < 0) continue;
    out.push({ from: sentence.from + i, to: sentence.from + i + m[0].length, at: m.index! });
    cursor = i + m[0].length;
  }
  return out;
}

/** The word a boundary event at `charIndex` (in the spoken text) falls in. */
export function wordAt(words: readonly WordRange[], charIndex: number): WordRange | null {
  let hit: WordRange | null = null;
  for (const w of words) {
    if (w.at <= charIndex) hit = w;
    else break;
  }
  return hit;
}

// ── Settings and position (per device; a convenience, so browser storage) ──

export interface TtsSettings {
  /** 0.5 – 2. */
  rate: number;
  /** Base language ("he", "en") → the system voice's voiceURI. */
  voices: Record<string, string>;
}

const SETTINGS_KEY = "lumen.tts.settings";
const POSITION_KEY = "lumen.tts.position:";

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadTtsSettings(kv: KV | null = storage()): TtsSettings {
  try {
    const raw = JSON.parse(kv?.getItem(SETTINGS_KEY) ?? "null") as Partial<TtsSettings> | null;
    const rate = typeof raw?.rate === "number" && raw.rate >= 0.5 && raw.rate <= 2 ? raw.rate : 1;
    const voices = raw?.voices && typeof raw.voices === "object" ? Object.fromEntries(Object.entries(raw.voices).filter(([, v]) => typeof v === "string")) : {};
    return { rate, voices };
  } catch {
    return { rate: 1, voices: {} };
  }
}

export function saveTtsSettings(next: TtsSettings, kv: KV | null = storage()): void {
  try {
    kv?.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* why: storage blocked — the setting lasts this session only */
  }
}

/**
 * Where to resume in a note: the saved sentence if its text is still there
 * (searched near the saved index, since edits shift it), else the start.
 */
export function resumeIndex(sentences: readonly Sentence[], noteKey: string, kv: KV | null = storage()): number {
  try {
    const saved = JSON.parse(kv?.getItem(POSITION_KEY + noteKey) ?? "null") as { index?: number; text?: string } | null;
    if (!saved || typeof saved.index !== "number" || typeof saved.text !== "string") return 0;
    let best = -1;
    sentences.forEach((s, i) => {
      if (s.text === saved.text && (best < 0 || Math.abs(i - saved.index!) < Math.abs(best - saved.index!))) best = i;
    });
    return best > 0 ? best : 0;
  } catch {
    return 0;
  }
}

export function savePosition(noteKey: string, sentence: Sentence | null, index: number, kv: KV | null = storage()): void {
  try {
    if (!sentence) kv?.removeItem(POSITION_KEY + noteKey);
    else kv?.setItem(POSITION_KEY + noteKey, JSON.stringify({ index, text: sentence.text }));
  } catch {
    /* why: storage blocked — the position is not kept */
  }
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

/** The neural voice's run, when one is reading (W2.6). */
let neuralAbort: AbortController | null = null;

export function stopSpeaking(): void {
  speaking = false;
  currentRun++;
  neuralAbort?.abort();
  neuralAbort = null;
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
 * `onWord` (plan W5.6) gets the note range of each word as the voice reaches
 * it, from the engine's `boundary` events; engines that send none (some
 * voices on Linux) leave the sentence highlight alone.
 */
export async function speak(
  markdown: string,
  opts: {
    uiLang: string;
    rate?: number;
    onSentence?: (s: Sentence, index: number) => void;
    onWord?: (range: { from: number; to: number }) => void;
    run?: number;
    /** Start at this sentence (resume, W2.6). */
    startAt?: number;
    /** Base language → system voiceURI (TtsSettings.voices). */
    voices?: Record<string, string>;
  },
): Promise<boolean> {
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
    const start = Math.min(Math.max(opts.startAt ?? 0, 0), sentences.length - 1);
    for (let i = start; i < sentences.length; i++) {
      const s = sentences[i];
      // why: a stop, or a newer reading, ends this one — two readings never interleave
      if (!isCurrentRun(run)) break;
      const lang = langFor(s.text, docLang, detect);
      const u = new SpeechSynthesisUtterance(s.text);
      u.lang = lang;
      const v = voiceFor(lang, allowNetwork, opts.voices?.[lang.split("-")[0].toLowerCase()]);
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
      const onWord = opts.onWord;
      if (onWord) {
        const words = mapSpokenWords(s.text, markdown.slice(s.from, s.to), s.from);
        u.onboundary = (e: SpeechSynthesisEvent) => {
          // why: "sentence" boundaries carry an index too; only words move the highlight
          if (e.name && e.name !== "word") return;
          if (!isCurrentRun(run)) return;
          const w = wordAtChar(words, e.charIndex);
          if (w) onWord({ from: w.from, to: w.to });
        };
      }
      opts.onSentence?.(s, i);
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

/** A note's key for the saved position: its workspace path, else its name. */
const noteKeyOf = (doc: { workspaceName?: string | null; name?: string | null }): string => doc.workspaceName ?? doc.name ?? "untitled";

type T = (key: string, vars?: Record<string, string | number>) => string;
type Toast = (message: string, type?: "info" | "error" | "success") => void;

/**
 * The palette's *Read aloud* (run again to stop). Claims the reading before
 * anything is awaited (a second press stops it), asks once before a network
 * voice is used (never under local-only), resumes where this note was left
 * (W2.6), highlights the sentence and the word, and remembers the position.
 */
export async function readAloudCommand(deps: {
  content: string;
  doc: { workspaceName?: string | null; name?: string | null };
  uiLang: string;
  t: T;
  toast: Toast;
  /** The reading speed (reading aids, plan W5.6); default 1. */
  rate?: number;
  /** Ask before a network voice is used; omitted: never ask (local voices only). */
  confirmNetworkVoice?: () => Promise<boolean>;
}): Promise<void> {
  if (isSpeaking()) {
    stopSpeaking();
    return;
  }
  if (!ttsAvailable()) {
    deps.toast(deps.t("toast.tts.unavailable"), "error");
    return;
  }
  const { content } = deps;
  // why: claim the reading before any await — a second press while voices load or the prompt is open stops it, never starts a second one
  const run = beginSpeaking();
  try {
    await voicesReady(); // why: the list is empty until voiceschanged on a fresh page
    if (!isCurrentRun(run)) return;
    const key = noteKeyOf(deps.doc);
    const sentences = speakableSentences(content);
    const startAt = resumeIndex(sentences, key);
    const range = (detail: unknown) => window.dispatchEvent(new CustomEvent("lumen-speech-range", { detail }));
    const word = (detail: unknown) => window.dispatchEvent(new CustomEvent("lumen-speech-word", { detail }));
    let last = -1;
    const onSentence = (s: Sentence, i: number) => {
      last = i;
      savePosition(key, s, i);
      range({ from: s.from, to: s.to });
    };
    const rate = deps.rate ?? 1;
    // A licensed neural Hebrew voice, when one exists (none yet — decision 15.10). It runs on the device.
    if (hebrewRatio(content) > 0.5) {
      const { HEBREW_VOICES } = await import("./tts/voices");
      const neural = HEBREW_VOICES.length ? await import("./tts/neuralReader") : null;
      const voice = neural ? await neural.neuralHebrewVoice() : null;
      if (!isCurrentRun(run)) return;
      if (neural && voice) {
        if (startAt > 0) deps.toast(deps.t("tts.resumed", { n: startAt + 1, total: sentences.length }), "info");
        const ctl = new AbortController();
        neuralAbort = ctl;
        try {
          const [{ pointHebrew }, { uiConfirm }] = await Promise.all([import("./nikudService"), import("../ui/PromptDialog")]);
          await neural.speakNeural(voice, sentences, {
            rate,
            startAt,
            source: content,
            signal: ctl.signal,
            wordRanges,
            point: (text) => pointHebrew(text, { consent: { confirm: uiConfirm, t: deps.t } }),
            onSentence,
            onWord: (_s, w) => word({ from: w.from, to: w.to }),
            onFirstAudio: (ms) => log.info(`neural read-aloud: first audio after ${Math.round(ms)} ms`),
          });
        } finally {
          if (neuralAbort === ctl) neuralAbort = null;
          range(null);
          word(null);
        }
        if (last === sentences.length - 1 && !ctl.signal.aborted) savePosition(key, null, 0);
        return;
      }
    }
    // No voice on this device, but the browser offers network voices: ask once (never under local-only).
    if (deps.confirmNetworkVoice && !hasLocalVoiceFor(content, deps.uiLang) && offersNetworkVoices() && !networkVoicesAllowed() && thirdPartyServicesAllowed()) {
      if (await deps.confirmNetworkVoice()) allowNetworkVoices();
      if (!isCurrentRun(run)) return;
    }
    if (startAt > 0) deps.toast(deps.t("tts.resumed", { n: startAt + 1, total: sentences.length }), "info");
    const ok = await speak(content, { run, rate, uiLang: deps.uiLang, voices: loadTtsSettings().voices, startAt, onSentence, onWord: (w) => word(w) }).finally(() => {
      range(null);
      word(null);
    });
    // Read to the end (not stopped): the next run starts over.
    if (last === sentences.length - 1 && run === currentRun) savePosition(key, null, 0);
    if (!ok) deps.toast(deps.t(/[\u0590-\u05FF]/.test(content) ? "toast.tts.noHebrewVoice" : "toast.tts.noLocalVoice"), "info");
  } finally {
    if (run === currentRun) speaking = false;
  }
}

const RATES = [0.75, 1, 1.25, 1.5, 2];

/**
 * *Read aloud: voice and speed* — the speed (stored with the reading aids,
 * plan W5.6, through `setRate`) and the system voice for the note's language.
 * A network voice (☁) is offered only where network voices may be used.
 */
export async function readAloudSettings(deps: {
  content: string;
  uiLang: string;
  t: T;
  toast: Toast;
  select: (o: { title?: string; message: string; defaultValue?: string; choices: { value: string; label: string }[] }) => Promise<string | null>;
  rate: number;
  setRate: (rate: number) => void;
}): Promise<void> {
  if (!ttsAvailable()) {
    deps.toast(deps.t("toast.tts.unavailable"), "error");
    return;
  }
  const settings = loadTtsSettings();
  const current = RATES.includes(deps.rate) ? deps.rate : 1;
  const rate = await deps.select({
    title: deps.t("tts.settings.title"),
    message: deps.t("tts.settings.rate"),
    defaultValue: String(current),
    choices: RATES.map((r) => ({ value: String(r), label: `${r}×` })),
  });
  if (rate === null) return;
  const lang = hebrewRatio(deps.content) > 0.3 || deps.uiLang === "he" ? "he" : deps.uiLang.split("-")[0];
  const allowNetwork = networkVoicesAllowed();
  const voices = (await voicesReady()).filter((v) => (allowNetwork || v.localService) && v.lang.toLowerCase().replace(/^iw/, "he").startsWith(lang));
  let voice: string | null = settings.voices[lang] ?? "";
  if (voices.length > 1) {
    voice = await deps.select({
      title: deps.t("tts.settings.title"),
      message: deps.t("tts.settings.voice", { lang }),
      defaultValue: settings.voices[lang] ?? voices[0].voiceURI,
      choices: voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})${v.localService ? "" : " ☁"}` })),
    });
    if (voice === null) return;
  }
  deps.setRate(Number(rate));
  saveTtsSettings({ rate: Number(rate), voices: { ...settings.voices, ...(voice ? { [lang]: voice } : {}) } });
  deps.toast(deps.t("tts.settings.saved", { rate: `${rate}×` }), "success");
  // Decision 15.10: no licensed neural Hebrew voice yet — say what is used.
  if (lang === "he") {
    const { HEBREW_VOICES } = await import("./tts/voices");
    if (!HEBREW_VOICES.length) deps.toast(deps.t("tts.neural.none"), "info");
  }
}
