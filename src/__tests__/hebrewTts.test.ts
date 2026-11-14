/**
 * Plan W2.6 — local neural Hebrew read-aloud: the vocalized-Hebrew → IPA
 * rules, the voice-pack seam (no licensed Hebrew voice yet, decision 15.10),
 * the neural reader with a fake voice, and read-aloud's word highlight,
 * speed / voice settings and saved position.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVocalized, sentenceToIpa, wordToIpa } from "../ai/tts/hebrewG2P";
import { HEBREW_VOICES, parsePiperConfig, phonemeIds, scales, usableVoices, wordTimes, type PiperConfig, type VoicePack } from "../ai/tts/voices";
import { prepareSentence, speakNeural, verifiedFile, type Synth } from "../ai/tts/neuralReader";
import { __resetTts, loadTtsSettings, readAloudCommand, resumeIndex, savePosition, saveTtsSettings, speak, speakableSentences, wordAt, wordRanges } from "../ai/tts";

const WORDS: Array<[string, string]> = [
  ["שָׁלוֹם", "ʃaˈlom"],
  ["תּוֹדָה", "toˈda"],
  ["בְּרֵאשִׁית", "beʁeˈʃit"],
  ["מֶלֶךְ", "ˈmeleχ"],
  ["כֶּלֶב", "ˈkelev"],
  ["סֵפֶר", "ˈsefeʁ"],
  ["בֹּקֶר", "ˈbokeʁ"],
  ["לָכֶם", "laˈχem"],
  ["בַּיִת", "ˈbajit"],
  ["נַעַר", "ˈnaʔaʁ"],
  ["רוּחַ", "ʁuaχ"],
  ["שִׂמְחָה", "simˈχa"],
  ["יְלָדִים", "jelaˈdim"],
  ["סְפָרִים", "sfaˈʁim"],
  ["שְׁאֵלָה", "ʃeʔeˈla"],
  ["חַוָּה", "χaˈva"],
  ["עוֹלָם", "oˈlam"],
  ["מְדַבֵּר", "medaˈbeʁ"],
  ["לִכְתֹּב", "liχˈtov"],
  ["תְּפִלָּה", "tfiˈla"],
  ["יוֹם", "jom"],
  ["הוּא", "hu"],
];

describe("Hebrew G2P (W2.6)", () => {
  for (const [word, ipa] of WORDS) it(`${word} → ${ipa}`, () => expect(wordToIpa(word)).toBe(ipa));

  it("the ole mark (U+05AB) overrides the default stress", () => {
    expect(wordToIpa("אַבָּא")).toBe("aˈba");
    expect(wordToIpa("אַ\u05ABבָּא")).toBe("ˈaba");
  });

  it("sentences keep punctuation, split the maqaf, leave other scripts alone", () => {
    expect(sentenceToIpa("שָׁלוֹם, עוֹלָם! Hello.")).toBe("ʃaˈlom, oˈlam! Hello.");
    expect(sentenceToIpa("בֵּית־סֵפֶר")).toBe("bet ˈsefeʁ");
  });

  it("knows when text has niqqud to read", () => {
    expect(isVocalized("שָׁלוֹם עוֹלָם")).toBe(true);
    expect(isVocalized("שלום עולם")).toBe(false);
    expect(isVocalized("Hello")).toBe(false);
  });
});

const CONFIG: PiperConfig = parsePiperConfig({
  audio: { sample_rate: 22050 },
  phoneme_id_map: { "^": [1], $: [2], _: [0], a: [10], l: [11], o: [12], m: [13], ʃ: [14], ˈ: [15], " ": [3] },
  inference: { noise_scale: 0.5, length_scale: 1.2, noise_w: 0.7 },
});

const VOICE: VoicePack = {
  id: "test-voice",
  language: "he",
  license: "CC0-1.0",
  attribution: "",
  model: { url: "https://example.com/v.onnx", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  config: { url: "https://example.com/v.json", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
};

describe("voice-pack seam (W2.6, decision 15.10)", () => {
  it("ships no Hebrew voice: none is licensed", () => {
    expect(HEBREW_VOICES).toEqual([]);
  });

  it("a voice is usable only when the registry allows it (verified) and its files are pinned", () => {
    expect(usableVoices([VOICE], [{ id: "test-voice", class: "allowed", verified: true }])).toEqual([VOICE]);
    expect(usableVoices([VOICE], [{ id: "test-voice", class: "allowed", verified: false }])).toEqual([]);
    expect(usableVoices([VOICE], [{ id: "test-voice", class: "forbidden", verified: true }])).toEqual([]);
    expect(usableVoices([VOICE], [])).toEqual([]);
    expect(usableVoices([{ ...VOICE, model: { ...VOICE.model, sha256: "x" } }], [{ id: "test-voice", class: "allowed", verified: true }])).toEqual([]);
  });

  it("Piper ids: BOS, each phoneme then the pad, EOS; unknown phonemes reported", () => {
    expect(phonemeIds("ʃaˈlom", CONFIG)).toEqual({ ids: [1, 14, 0, 10, 0, 15, 0, 11, 0, 12, 0, 13, 0, 2], unknown: [] });
    expect(phonemeIds("χa", CONFIG).unknown).toEqual(["χ"]);
    expect(() => parsePiperConfig({ audio: { sample_rate: 1 }, phoneme_id_map: { "^": [1] } })).toThrow('lacks the "$" phoneme');
  });

  it("speed scales the length, clamped to 0.5–2×", () => {
    expect(scales(CONFIG)).toEqual([0.5, 1.2, 0.7]);
    expect(scales(CONFIG, 2)[1]).toBeCloseTo(0.6);
    expect(scales(CONFIG, 10)[1]).toBeCloseTo(0.6);
  });

  it("word start times share the duration by phoneme count", () => {
    expect(wordTimes(["ab", "abcd"], 4)).toEqual([0, 1.5]);
  });
});

describe("neural reader with a fake voice (W2.6)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a file whose checksum does not match, and uses one that does", async () => {
    const ok = await verifiedFile(VOICE.model, { fetch: (async () => new Response("abc")) as typeof fetch, caches: null });
    expect(new TextDecoder().decode(ok)).toBe("abc");
    await expect(verifiedFile(VOICE.model, { fetch: (async () => new Response("abd")) as typeof fetch, caches: null })).rejects.toThrow("checksum");
  });

  it("points unpointed sentences, prefetches the next one, reports the first audio once, highlights words", async () => {
    const source = "שלום עולם. שָׁלוֹם לָכֶם.";
    const sentences = speakableSentences(source);
    const synthCalls: number[][] = [];
    const synth: Synth = { config: CONFIG, synth: async (ids) => (synthCalls.push(ids), new Float32Array(2205)) };
    const ended: Array<() => void> = [];
    const audio = {
      destination: {},
      createBuffer: (_c: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: () => undefined }),
      createBufferSource: () => {
        const src = { buffer: null as unknown, onended: null as null | (() => void), connect: () => undefined, stop: () => undefined, start: () => ended.push(() => src.onended?.()) };
        return src;
      },
    } as unknown as AudioContext;
    const point = vi.fn(async (t: string) => t.replace("שלום", "שָׁלוֹם").replace("עולם", "עוֹלָם"));
    const order: string[] = [];
    const first = vi.fn();
    const done = speakNeural(VOICE, sentences, { synth, audio, point, source, wordRanges, onSentence: (_s, i) => order.push(`s${i}`), onFirstAudio: first });
    await vi.waitFor(() => expect(ended.length).toBe(1));
    // Sentence 2 is already being synthesized while sentence 1 plays.
    expect(synthCalls.length).toBe(2);
    ended[0]();
    await vi.waitFor(() => expect(ended.length).toBe(2));
    ended[1]();
    await done;
    expect(order).toEqual(["s0", "s1"]);
    expect(point).toHaveBeenCalledTimes(1); // the second sentence already had niqqud
    expect(first).toHaveBeenCalledTimes(1);
    expect(prepareSentence("שָׁלוֹם לָכֶם").words).toEqual(["ʃaˈlom", "laˈχem"]);
  });
});

describe("read-aloud: words, settings, position (W2.6)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the spoken words back to the note, past link markup", () => {
    const src = "Read [the docs](https://example.com) now.";
    const [s] = speakableSentences(src);
    const words = wordRanges(src, s);
    expect(words.map((w) => src.slice(w.from, w.to))).toEqual(["Read", "the", "docs", "now"]);
    expect(src.slice(wordAt(words, 9)!.from, wordAt(words, 9)!.to)).toBe("docs");
    expect(wordAt(words, 0)?.from).toBe(0);
  });

  it("settings: defaults, a saved speed and voice, a corrupt value ignored", () => {
    const kv = new Map<string, string>();
    const store = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) };
    expect(loadTtsSettings(store)).toEqual({ rate: 1, voices: {} });
    saveTtsSettings({ rate: 1.5, voices: { he: "Carmit" } }, store);
    expect(loadTtsSettings(store)).toEqual({ rate: 1.5, voices: { he: "Carmit" } });
    kv.set("lumen.tts.settings", '{"rate": 9, "voices": {"he": 3}}');
    expect(loadTtsSettings(store)).toEqual({ rate: 1, voices: {} });
    kv.set("lumen.tts.settings", "{");
    expect(loadTtsSettings(store)).toEqual({ rate: 1, voices: {} });
  });

  it("resumes at the saved sentence even after an edit moved it; forgets it at the end", () => {
    const kv = new Map<string, string>();
    const store = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) };
    const before = speakableSentences("One. Two. Three.");
    savePosition("a.md", before[2], 2, store);
    expect(resumeIndex(speakableSentences("Zero. One. Two. Three."), "a.md", store)).toBe(3);
    expect(resumeIndex(speakableSentences("Other text."), "a.md", store)).toBe(0);
    savePosition("a.md", null, 0, store);
    expect(resumeIndex(before, "a.md", store)).toBe(0);
  });

  it("speak(): starts at startAt, and reports words from the voice's boundary events", async () => {
    class U {
      lang = "";
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onboundary: ((e: { name: string; charIndex: number }) => void) | null = null;
      constructor(public text: string) {}
    }
    const spoken: string[] = [];
    // The train speaks only with a voice on the device (never the browser's network pick).
    const synth = {
      getVoices: () => [{ lang: "en-US", localService: true, name: "Local", voiceURI: "local-en" }],
      cancel: () => undefined,
      speak: (u: U) => {
        spoken.push(u.text);
        queueMicrotask(() => {
          u.onboundary?.({ name: "word", charIndex: 0 });
          u.onboundary?.({ name: "sentence", charIndex: 0 });
          u.onboundary?.({ name: "word", charIndex: 6 });
          u.onend?.();
        });
      },
    };
    vi.stubGlobal("SpeechSynthesisUtterance", U);
    vi.stubGlobal("speechSynthesis", synth);
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    const src = "One two. Three four.";
    const words: string[] = [];
    await speak(src, { uiLang: "en", startAt: 1, onWord: (w) => words.push(src.slice(w.from, w.to)) });
    expect(spoken).toEqual(["Three four."]);
    expect(words).toEqual(["Three", "four"]);
  });

  it("readAloudCommand: Hebrew without a licensed voice reads with the system voice, and fetches nothing", async () => {
    __resetTts();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    class U {
      lang = "";
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    const spoken: U[] = [];
    const voices = [{ lang: "he-IL", localService: true, name: "Carmit", voiceURI: "carmit" }];
    const synth = { getVoices: () => voices, cancel: () => undefined, speak: (u: U) => (spoken.push(u), queueMicrotask(() => u.onend?.())) };
    vi.stubGlobal("SpeechSynthesisUtterance", U);
    vi.stubGlobal("speechSynthesis", synth);
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    const toasts: string[] = [];
    await readAloudCommand({ content: "שלום לכם. מה שלומכם?", doc: { name: "he.md" }, uiLang: "he", t: (k) => k, toast: (m) => toasts.push(m) });
    expect(spoken.map((u) => u.lang)).toEqual(["he-IL", "he-IL"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    // Without a Hebrew voice on the device it says so, and reads nothing with another one.
    voices.length = 0;
    spoken.length = 0;
    await readAloudCommand({ content: "שלום לכם. מה שלומכם?", doc: { name: "he2.md" }, uiLang: "he", t: (k) => k, toast: (m) => toasts.push(m) });
    expect(spoken).toEqual([]);
    expect(toasts).toContain("toast.tts.noHebrewVoice");
  });
});
