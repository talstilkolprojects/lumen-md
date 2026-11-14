/**
 * Plan 6.17 — cloud only by choice: an audit of every path that could send
 * content to a cloud service.
 *
 *   1. static: every source file that names a cloud AI host or a browser
 *      speech service is in ROUTES below, and each route's file still holds
 *      its gate — a new cloud path without a gate fails here;
 *   2. the docs table (docs/…/ai/cloud-routes.md, English and Hebrew) lists
 *      every route;
 *   3. per path: under local-only nothing is sent, and the services nobody
 *      set up (public LanguageTool, browser speech recognition, server-side
 *      voices) stay off under local-first too — only the explicit `cloud`
 *      policy turns them on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const state = { aiKey: "sk", useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null, doc: { content: "" }, setContent: vi.fn() };
vi.mock("../store/useStore", () => ({
  useAppStore: { getState: () => state, setState: vi.fn() },
  // The real helper: dictation now keys its target note by tab id.
  tabIdOf: (d: { workspaceName?: string | null; name: string }) => d.workspaceName || d.name || "Untitled",
  // Dictation follows its note across a rename (#197); no renames happen here.
  onTabIdChange: () => () => undefined,
}));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

interface Route {
  /** The id the docs table uses. */
  id: string;
  /** File (relative to src/) that sends the request. */
  file: string;
  /** What in that file reaches the cloud. */
  marker: RegExp;
  /** The policy gate that must stay in that file. */
  gate: RegExp;
}

/** Every cloud route in the app. Adding one means adding it here, gated, and to the docs table. */
const ROUTES: Route[] = [
  { id: "chat-openai", file: "ai/llm.ts", marker: /api\.openai\.com\/v1\/chat\/completions/, gate: /assertCloudProvider\("openai"\)/ },
  { id: "chat-anthropic", file: "ai/anthropicProvider.ts", marker: /api\.anthropic\.com/, gate: /assertCloudAllowed\("Anthropic \(Claude\)"\)/ },
  { id: "chat-gemini", file: "ai/geminiProvider.ts", marker: /generativelanguage\.googleapis\.com/, gate: /assertCloudAllowed\("Google Gemini"\)/ },
  { id: "chat-mistral", file: "ai/mistralProvider.ts", marker: /api\.mistral\.ai/, gate: /assertCloudAllowed\("Mistral"\)/ },
  { id: "embeddings-openai", file: "ai/embeddingProvider.ts", marker: /api\.openai\.com\/v1\/embeddings/, gate: /assertCloudAllowed\(/ },
  { id: "batch-api", file: "ai/batch.ts", marker: /api\.(anthropic|openai)\.com/, gate: /assertCloudAllowed\(/ },
  { id: "fine-tune", file: "ai/fineTune.ts", marker: /api\.openai\.com\/v1\/(files|fine_tuning)/, gate: /assertCloudAllowed\(/ },
  { id: "whisper-1", file: "ai/transcribe.ts", marker: /api\.openai\.com\/v1\/audio\/transcriptions/, gate: /assertCloudAllowed\(/ },
  { id: "languagetool", file: "ai/grammar.ts", marker: /api\.languagetool\.org/, gate: /thirdPartyServicesAllowed\(\)/ },
  { id: "web-research", file: "research/agent.ts", marker: /anthropicWebResearch|researchEndpoint\(\)/, gate: /assertCloudAllowed\("the research service/ },
  { id: "speech-recognition", file: "ui/VoiceDictation.tsx", marker: /\bSpeechRecognition\b/, gate: /if \(!thirdPartyServicesAllowed\(\)\)/ },
  { id: "network-voices", file: "ai/tts.ts", marker: /speechSynthesis\.speak/, gate: /allowNetwork \|\| v\.localService/ },
  { id: "plantuml-kroki", file: "plugins/plantumlPolicy.ts", marker: /kroki\.io\/plantuml/, gate: /if \(!krokiAllowed\(source, policy\)\)/ },
  // W5.1: the reference only, after the user confirms each lookup; a saved copy needs no request.
  { id: "sefaria-texts", file: "sources/sefaria/app.ts", marker: /ledgerFetch\(\{ force: \{ category: "cloud-text", reason: LEDGER_REASON \}, consent: true \}\)/, gate: /asked \?\?= await confirm\(\);\s*if \(!asked\) throw new DeclinedError\(\)/ },
  // W7.19 (review 20): one note, to the user's own PDS, only after a confirmation that says the record is public and permanent.
  { id: "atproto-publish", file: "publish/standardSite.ts", marker: /ledgerFetch\(\{ force: \{ category: "third-party", reason: ATPROTO_REASON \}, consent: true \}\)/, gate: /asked \?\?= confirm\(\);\s*if \(!\(await asked\)\) throw new DeclinedError\(\)/ },
];

/** Names of cloud AI hosts and browser services that talk to their vendor. */
const CLOUD_MARKER = /bsky\.social|plc\.directory|www\.sefaria\.org\/api|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.languagetool\.org|kroki\.io\/|\bSpeechRecognition\b|speechSynthesis\.speak/;

/**
 * Files that name a cloud host without sending anything: classification and
 * types, Sefaria's client (it sends through the fetch that sources/sefaria/app.ts
 * gates and hands it), and the live-dictation panel, which only detects whether the browser
 * has a speech service; it starts it through VoiceDictation's gated
 * startBrowserSpeech.
 */
const NAMES_ONLY = new Set(["ai/privacyLedger.ts", "types/fileSystemAccess.d.ts", "ui/LiveDictation.tsx", "sources/sefaria/client.ts"]);

const SRC = join(__dirname, "..");
const ROOT = join(SRC, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|eval)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Comments out of the way, so a doc comment that names a host is not a request. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("cloud routes: static audit (6.17)", () => {
  const files = sources(SRC).map((p) => ({ path: relative(SRC, p).replace(/\\/g, "/"), text: code(readFileSync(p, "utf8")) }));

  it("every file that reaches a cloud service is an audited route", () => {
    const audited = new Set(ROUTES.map((r) => r.file));
    const unaudited = files.filter((f) => CLOUD_MARKER.test(f.text) && !audited.has(f.path) && !NAMES_ONLY.has(f.path)).map((f) => f.path);
    expect(unaudited).toEqual([]);
  });

  it.each(ROUTES.map((r) => [r.id, r] as const))("%s still holds its policy gate", (_id, r) => {
    const f = files.find((x) => x.path === r.file);
    expect(f, r.file).toBeDefined();
    expect(f!.text).toMatch(r.marker);
    expect(f!.text).toMatch(r.gate);
  });

  it("the docs table lists every route, in English and in Hebrew", () => {
    for (const page of ["docs/src/content/docs/ai/cloud-routes.md", "docs/src/content/docs/he/ai/cloud-routes.md"]) {
      const text = readFileSync(join(ROOT, page), "utf8");
      const missing = ROUTES.filter((r) => !text.includes(`\`${r.id}\``)).map((r) => r.id);
      expect(missing, page).toEqual([]);
    }
  });
});

describe("cloud routes: each path under each policy (6.17)", () => {
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
  const urls = () => fetchSpy.mock.calls.map(([u]) => String(u));
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only");
    for (const p of ["anthropic", "gemini", "mistral"]) localStorage.setItem(`lumen.ai.key.${p}`, "k");
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("the cloud chat providers refuse under local-only even when called directly", async () => {
    const { chatAnthropic, chatAnthropicStream, anthropicWebResearch } = await import("../ai/anthropicProvider");
    const { chatGemini, chatGeminiStream } = await import("../ai/geminiProvider");
    const { chatMistral, chatMistralStream } = await import("../ai/mistralProvider");
    const msgs = [{ role: "user" as const, content: "secret note" }];
    for (const call of [() => chatAnthropic(msgs), () => chatGemini(msgs), () => chatMistral(msgs), () => anthropicWebResearch(msgs)]) {
      await expect(call()).rejects.toMatchObject({ code: "POLICY" });
    }
    for (const gen of [chatAnthropicStream(msgs), chatGeminiStream(msgs), chatMistralStream(msgs)]) {
      await expect(gen.next()).rejects.toMatchObject({ code: "POLICY" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fine-tune upload and job creation refuse under local-only on their own", async () => {
    const { uploadTrainingFile, createFineTuneJob } = await import("../ai/fineTune");
    await expect(uploadTrainingFile('{"messages":[]}')).rejects.toMatchObject({ code: "POLICY" });
    await expect(createFineTuneJob("file-1")).rejects.toMatchObject({ code: "POLICY" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the public LanguageTool API needs the explicit cloud policy; a LanguageTool the user configured follows local-first", async () => {
    const { checkGrammar, clearGrammarCache } = await import("../ai/grammar");
    const text = "This are a sentence with enough words to be checked by the tool.";
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ matches: [] }), { status: 200 }));
    // local-first (a cloud key, no explicit cloud choice): the public API stays off.
    localStorage.setItem("lumen.ai.policy", "local-first");
    expect(await checkGrammar(text)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // A remote LanguageTool the user set up themselves is their choice outside local-only.
    clearGrammarCache();
    localStorage.setItem("lumen.grammar.endpoint", "https://lt.example.com/v2/check");
    await checkGrammar(text);
    expect(urls()).toEqual(["https://lt.example.com/v2/check"]);
    // The cloud policy, chosen explicitly, turns the public API on.
    clearGrammarCache();
    fetchSpy.mockClear();
    localStorage.removeItem("lumen.grammar.endpoint");
    localStorage.setItem("lumen.ai.policy", "cloud");
    await checkGrammar(text);
    expect(urls()[0]).toContain("api.languagetool.org");
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 200 }));
  });

  it("the policy helper: third-party services only under cloud", async () => {
    const { thirdPartyServicesAllowed } = await import("../ai/policy");
    expect(thirdPartyServicesAllowed("local-only")).toBe(false);
    expect(thirdPartyServicesAllowed("local-first")).toBe(false);
    expect(thirdPartyServicesAllowed("cloud")).toBe(true);
  });

  describe("read aloud", () => {
    const spoken: Array<{ text: string; voice: string | null }> = [];
    const voices = [
      { name: "Google עברית", lang: "he-IL", localService: false },
      { name: "Google US English", lang: "en-US", localService: false },
      { name: "Samantha", lang: "en-US", localService: true },
    ];
    class Utterance {
      lang = "";
      rate = 1;
      voice: { name: string } | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    beforeEach(() => {
      spoken.length = 0;
      vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => voices,
          cancel: () => {},
          speak: (u: Utterance) => {
            spoken.push({ text: u.text, voice: u.voice?.name ?? null });
            u.onend?.();
          },
        },
      });
    });

    it("a server-side voice is never picked outside the cloud policy", async () => {
      const { voiceFor } = await import("../ai/tts");
      for (const policy of ["local-only", "local-first"]) {
        localStorage.setItem("lumen.ai.policy", policy);
        expect(voiceFor("he-IL")).toBeUndefined();
        expect(voiceFor("en-US")?.name).toBe("Samantha");
      }
      localStorage.setItem("lumen.ai.policy", "cloud");
      // Under cloud, still only after the read-aloud opt-in.
      expect(voiceFor("he-IL")).toBeUndefined();
      const { allowNetworkVoices } = await import("../ai/tts");
      allowNetworkVoices();
      expect(voiceFor("he-IL")?.name).toBe("Google עברית");
    });

    it("without a voice on this device the sentence is skipped, not handed to the default voice", async () => {
      const { speak } = await import("../ai/tts");
      localStorage.setItem("lumen.ai.policy", "local-first");
      expect(await speak("שלום עולם. Hello there.", { uiLang: "en" })).toBe(false);
      expect(spoken).toEqual([{ text: "Hello there.", voice: "Samantha" }]);
    });
  });

  it("dictation: the browser's speech service runs only under the cloud policy", async () => {
    vi.doMock("../ai/transcribe", () => ({ transcribe: vi.fn(), summarizeMemo: vi.fn(), formatVoiceMemo: vi.fn() }));
    const ctor = vi.fn();
    class FakeRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult = null;
      onerror = null;
      onend = null;
      constructor() {
        ctor();
      }
      start() {}
      stop() {}
    }
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    // Hebrew opens the live panel, whose browser fallback is startBrowserSpeech;
    // the user already agreed to the browser service, so only the policy decides.
    localStorage.setItem("lumen.dictate.webSpeech", "1");
    const { startBrowserSpeech } = await import("../ui/VoiceDictation");
    for (const policy of ["local-only", "local-first"]) {
      localStorage.setItem("lumen.ai.policy", policy);
      startBrowserSpeech("he-IL");
      await Promise.resolve();
      expect(ctor, policy).not.toHaveBeenCalled();
    }
    localStorage.setItem("lumen.ai.policy", "cloud");
    startBrowserSpeech("he-IL");
    expect(ctor).toHaveBeenCalledTimes(1);
    document.getElementById("voice-recording-root")?.remove();
    vi.doUnmock("../ai/transcribe");
  });

  describe("PlantUML via kroki.io", () => {
    beforeEach(async () => {
      const { __resetKrokiPolicy } = await import("../plugins/plantumlPolicy");
      const { __resetLedger } = await import("../ai/privacyLedger");
      __resetKrokiPolicy();
      __resetLedger();
      fetchSpy.mockImplementation(async () => new Response("<svg/>", { status: 200 }));
    });
    afterEach(() => fetchSpy.mockImplementation(async () => new Response("{}", { status: 200 })));

    it("under local-only and local-first nothing is sent until the user chooses this diagram; the block is in the ledger once", async () => {
      const { renderViaKroki, KrokiBlockedError, optInKroki } = await import("../plugins/plantumlPolicy");
      const { ledgerEntries } = await import("../ai/privacyLedger");
      for (const policy of ["local-only", "local-first"]) {
        localStorage.setItem("lumen.ai.policy", policy);
        await expect(renderViaKroki(`@startuml\nA -> B: ${policy}\n@enduml`)).rejects.toBeInstanceOf(KrokiBlockedError);
        await expect(renderViaKroki(`@startuml\nA -> B: ${policy}\n@enduml`)).rejects.toBeInstanceOf(KrokiBlockedError);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ledgerEntries().filter((e) => e.host === "kroki.io" && e.decision === "blocked")).toHaveLength(2);
      // The user sends this one diagram: it goes, marked as consented.
      localStorage.setItem("lumen.ai.policy", "local-only");
      const src = "@startuml\nA -> B: local-only\n@enduml";
      optInKroki(src);
      expect(await renderViaKroki(src)).toBe("<svg/>");
      expect(urls()).toEqual(["https://kroki.io/plantuml/svg"]);
      expect(ledgerEntries().some((e) => e.host === "kroki.io" && e.decision === "allowed" && e.consent === true)).toBe(true);
      // Editing the diagram asks again.
      await expect(renderViaKroki(src + "\n")).rejects.toBeInstanceOf(KrokiBlockedError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("the cloud policy, chosen explicitly, renders without asking", async () => {
      const { renderViaKroki } = await import("../plugins/plantumlPolicy");
      localStorage.setItem("lumen.ai.policy", "cloud");
      expect(await renderViaKroki("@startuml\nX -> Y\n@enduml")).toBe("<svg/>");
      expect(urls()).toEqual(["https://kroki.io/plantuml/svg"]);
    });

    it("the ledger classifies kroki.io as content leaving the device, blocked under local-only", async () => {
      const { classify, blockedByPolicy } = await import("../ai/privacyLedger");
      expect(classify("https://kroki.io/plantuml/svg")?.category).toBe("cloud-text");
      expect(blockedByPolicy("cloud-text", "local-only")).toBe(true);
    });
  });
});
