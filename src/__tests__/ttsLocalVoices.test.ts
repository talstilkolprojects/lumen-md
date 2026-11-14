/** 1.5 — read-aloud uses on-device voices only under local-only; network voices need an opt-in and are logged. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { voiceFor, networkVoicesAllowed, allowNetworkVoices, hasLocalVoiceFor, offersNetworkVoices, speak, langFor, voicesReady, NETWORK_VOICES_KEY, __resetTts } from "../ai/tts";
import { ledgerEntries } from "../ai/privacyLedger";

type V = Pick<SpeechSynthesisVoice, "name" | "lang" | "localService">;
const voices: V[] = [
  { name: "Google עברית", lang: "he-IL", localService: false },
  { name: "Samantha", lang: "en-US", localService: true },
];
const spoken: string[] = [];

let listVoices: () => V[] = () => voices;
const voiceListeners = new Set<() => void>();

beforeEach(() => {
  localStorage.clear();
  __resetTts();
  spoken.length = 0;
  listVoices = () => voices;
  voiceListeners.clear();
  vi.stubGlobal("SpeechSynthesisUtterance", class {
    text: string;
    lang = "";
    voice: V | null = null;
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => listVoices(),
      addEventListener: (_: string, f: () => void) => voiceListeners.add(f),
      removeEventListener: (_: string, f: () => void) => voiceListeners.delete(f),
      cancel: () => {},
      speak: (u: { text: string; onend: () => void }) => {
        spoken.push(u.text);
        u.onend();
      },
    },
  });
});

describe("read-aloud voices and the AI policy", () => {
  it("local-only never picks a network voice, even after an opt-in", () => {
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem(NETWORK_VOICES_KEY, "1");
    expect(networkVoicesAllowed()).toBe(false);
    expect(voiceFor("he-IL")).toBeUndefined();
    expect(voiceFor("en-US")?.name).toBe("Samantha");
  });

  it("other policies use a network voice only after the opt-in", () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    expect(voiceFor("he-IL")).toBeUndefined();
    allowNetworkVoices();
    expect(networkVoicesAllowed()).toBe(true);
    expect(voiceFor("he-IL")?.name).toBe("Google עברית");
  });

  it("reports what is missing so the command can ask", () => {
    expect(offersNetworkVoices()).toBe(true);
    expect(hasLocalVoiceFor("Hello there.", "en")).toBe(true);
    expect(hasLocalVoiceFor("שלום לכולם.", "he")).toBe(false);
  });

  it("under local-only a Hebrew note is not sent to a network voice and nothing is logged", async () => {
    localStorage.setItem("lumen.ai.policy", "local-only");
    const before = ledgerEntries().length;
    const ok = await speak("שלום לכולם. Hello there.", { uiLang: "he" });
    expect(ok).toBe(false);
    expect(spoken).toEqual(["Hello there."]);
    expect(ledgerEntries().length).toBe(before);
  });

  it("an allowed network voice is recorded in the privacy ledger once per voice", async () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    allowNetworkVoices();
    const before = ledgerEntries().length;
    const ok = await speak("שלום לכולם. מה שלומכם היום.", { uiLang: "he" });
    expect(ok).toBe(true);
    expect(spoken).toHaveLength(2);
    const added = ledgerEntries().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ host: "speech voice: Google עברית", category: "cloud-text", decision: "allowed" });
  });

  it("records every sentence sent through a network voice, as UTF-8 bytes, in one entry", async () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    allowNetworkVoices();
    const before = ledgerEntries().length;
    const a = "שלום לכולם.";
    const b = "מה שלומכם היום.";
    await speak(`${a} ${b}`, { uiLang: "he" });
    const added = ledgerEntries().slice(before);
    expect(added).toHaveLength(1);
    const utf8 = (x: string) => new TextEncoder().encode(x).length;
    expect(added[0].bytesOut).toBe(utf8(a) + utf8(b));
    expect(added[0].bytesOut).toBeGreaterThan(a.length + b.length); // Hebrew is 2 bytes a letter
  });

  it("keeps a confirmed opt-in for the session when storage refuses to save it", () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    allowNetworkVoices();
    spy.mockRestore();
    expect(localStorage.getItem(NETWORK_VOICES_KEY)).toBeNull();
    expect(networkVoicesAllowed()).toBe(true);
    localStorage.setItem("lumen.ai.policy", "local-only");
    expect(networkVoicesAllowed()).toBe(false); // local-only still wins
  });

  it("waits for voiceschanged when the list starts empty", async () => {
    listVoices = () => [];
    const p = voicesReady(5000);
    listVoices = () => voices;
    for (const f of [...voiceListeners]) f();
    expect((await p).map((v) => v.name)).toEqual(["Google עברית", "Samantha"]);
    listVoices = () => [];
    expect(await voicesReady(10)).toEqual([]); // gives up after the timeout
  });

  it("an English note under a Hebrew UI asks for an English voice and uses the local one", async () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    expect(langFor("Hello there.", "he-IL")).toBe("en");
    expect(langFor("Bonjour à tous.", "fr")).toBe("fr");
    expect(langFor("Привет всем.", "en")).toBe("ru");
    expect(hasLocalVoiceFor("Hello there. How are you.", "he")).toBe(true);
    expect(await speak("Hello there. How are you.", { uiLang: "he" })).toBe(true);
    expect(spoken).toEqual(["Hello there.", "How are you."]);
  });
});
