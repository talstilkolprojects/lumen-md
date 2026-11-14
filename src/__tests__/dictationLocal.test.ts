/** 1.3 — dictation runs on this device; the browser speech service never runs under local-only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chooseDictationEngine, downsampleTo16k, Segmenter, SerialQueue, WEB_SPEECH_KEY } from "../ai/dictation";
import { t } from "../i18n";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: vi.fn(async () => true) }));

describe("engine choice", () => {
  it("local-only always dictates on the device, even after an opt-in", () => {
    expect(chooseDictationEngine("local-only", true, true)).toBe("local");
  });
  it("only under cloud, and the browser service needs both availability and the opt-in (plan 6.17)", () => {
    expect(chooseDictationEngine("local-first", true, false)).toBe("local");
    expect(chooseDictationEngine("local-first", true, true)).toBe("local");
    expect(chooseDictationEngine("cloud", false, true)).toBe("local");
    expect(chooseDictationEngine("cloud", true, true)).toBe("webspeech");
  });
});

describe("audio pipeline", () => {
  it("resamples 48 kHz to 16 kHz by averaging", () => {
    const x = new Float32Array(48000).map((_, i) => (i % 3) - 1); // -1, 0, 1 repeating → mean 0
    const y = downsampleTo16k(x, 48000);
    expect(y.length).toBe(16000);
    expect(Math.max(...y.slice(0, 100).map(Math.abs))).toBeLessThan(1e-6);
  });

  it("emits fixed-length segments and drops silent ones", () => {
    const out: number[] = [];
    const seg = new Segmenter({ rate: 16000, seconds: 1, onSegment: (s) => out.push(s.length) });
    seg.push(new Float32Array(8000).fill(0.2));
    expect(out).toEqual([]);
    seg.push(new Float32Array(8000).fill(0.2)); // 1 s of sound → one segment
    seg.push(new Float32Array(16000)); // 1 s of silence → dropped
    seg.push(new Float32Array(4000).fill(0.3));
    seg.flush(); // the 0.25 s tail
    expect(out).toEqual([16000, 4000]);
  });

  it("transcribes segments one at a time, in order, past a failure", async () => {
    const q = new SerialQueue();
    const seen: number[] = [];
    void q.add(async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(1);
    });
    void q.add(async () => {
      throw new Error("segment failed");
    });
    void q.add(async () => {
      seen.push(3);
    });
    await q.idle();
    expect(seen).toEqual([1, 3]);
  });
});

describe("startVoiceRecording and the privacy policy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("under local-only, with no on-device path, it never starts the browser service and logs the block", async () => {
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem(WEB_SPEECH_KEY, "1");
    const ctor = vi.fn();
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = ctor;
    const { ledgerEntries } = await import("../ai/privacyLedger");
    const before = ledgerEntries().length;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    // Hebrew opens the live engine's panel first (#255); this case is the device path's fallback.
    startVoiceRecording("en-US"); // jsdom has no getUserMedia → local path unavailable
    await new Promise((r) => setTimeout(r, 0));
    expect(ctor).not.toHaveBeenCalled();
    const added = ledgerEntries().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ host: "browser speech recognition", decision: "blocked" });
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it("under cloud it asks first, then uses the browser service and logs it", async () => {
    localStorage.setItem("lumen.ai.policy", "cloud");
    const started = vi.fn();
    class FakeSR {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult = null;
      onerror = null;
      onend = null;
      start = started;
      stop() {}
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSR;
    const { ledgerEntries } = await import("../ai/privacyLedger");
    const before = ledgerEntries().length;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { uiConfirm } = await import("../ui/PromptDialog");
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(uiConfirm).toHaveBeenCalled();
    expect(localStorage.getItem(WEB_SPEECH_KEY)).toBe("1");
    expect(ledgerEntries().slice(before)[0]).toMatchObject({ host: "browser speech recognition", decision: "allowed" });
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    document.getElementById("voice-recording-root")?.remove();
  });
});

describe("dictated text stays with its note (review: #197)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("goes to the note dictation started in, even after a tab switch; to a new note once that one is closed", async () => {
    const { useAppStore, tabIdOf } = await import("../store/useStore");
    const { dictationSink } = await import("../ui/VoiceDictation");
    const s = () => useAppStore.getState();
    s().openTab({ name: "a.md", content: "A", workspaceName: null });
    const sink = dictationSink();
    s().openTab({ name: "b.md", content: "B", workspaceName: null });
    sink("hello");
    expect(s().doc.content).toBe("B");
    expect(s().openTabs.find((x) => x.id === "a.md")).toMatchObject({ content: "A\n\nhello", dirty: true });
    s().closeTab("a.md");
    sink("more");
    expect(tabIdOf(s().doc)).not.toBe("b.md");
    expect(s().doc.content).toBe("more");
    const taker = tabIdOf(s().doc);
    s().openTab({ name: "b.md", content: "B", workspaceName: null });
    sink("again"); // keeps using the note that took over
    expect(s().doc.content).toBe("B");
    expect(s().openTabs.find((x) => x.id === taker)?.content).toBe("more\n\nagain");
  });

  it("follows its note when autosave adopts it into the workspace, or it is renamed, under a new tab id", async () => {
    const { useAppStore, tabIdOf } = await import("../store/useStore");
    const { dictationSink } = await import("../ui/VoiceDictation");
    const s = () => useAppStore.getState();
    s().openTab({ name: "notes.txt", content: "A", workspaceName: null }); // ad-hoc: its tab id is its name
    const sink = dictationSink();
    sink("one");
    s().adoptWorkspaceName("notes.md"); // what autosave's adoptIntoWorkspace() does to a dirty ad-hoc note
    sink("two");
    expect(tabIdOf(s().doc)).toBe("notes.md");
    s().setDoc({ name: "final.md", workspaceName: "final.md", dirty: false }); // a rename in the file tree
    sink("three");
    expect(tabIdOf(s().doc)).toBe("final.md");
    expect(s().doc.content).toBe("A\n\none\n\ntwo\n\nthree");
    expect(s().openTabs.some((x) => x.name.startsWith("Dictation"))).toBe(false); // no stray "Dictation" note
    sink.dispose();
  });

  it("follows a note in a background tab that was moved in the vault", async () => {
    const { useAppStore } = await import("../store/useStore");
    const { syncOpenDocsAfterMove } = await import("../store/openDocs");
    const { dictationSink } = await import("../ui/VoiceDictation");
    const s = () => useAppStore.getState();
    s().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    const sink = dictationSink();
    s().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    syncOpenDocsAfterMove("a.md", "x/a.md", (c) => c);
    sink("hello");
    expect(s().doc.content).toBe("B");
    expect(s().openTabs.find((x) => x.id === "x/a.md")?.content).toBe("A\n\nhello");
    expect(s().openTabs.map((x) => x.id)).toEqual(["x/a.md", "b.md"]); // no stray "Dictation" note
    sink.dispose();
  });
});

describe("the browser speech service and a policy change mid-session (review: #197)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    // A session left by an earlier case keeps its pill: it belongs to a module instance that
    // resetModules dropped, which only a storage event (not setAiPolicy here) would reach.
    document.getElementById("voice-recording-root")?.remove();
  });

  it.each(["this tab", "another tab"])("stops when the policy turns local-only in %s", async (where) => {
    localStorage.setItem("lumen.ai.policy", "cloud");
    localStorage.setItem(WEB_SPEECH_KEY, "1");
    const stopped = vi.fn();
    class FakeSR {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult = null;
      onerror = null;
      onend = null;
      start() {}
      stop = stopped;
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSR;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { setAiPolicy } = await import("../ai/policy");
    startVoiceRecording("en-US");
    expect(document.getElementById("voice-recording-root")).not.toBeNull();
    if (where === "this tab") {
      setAiPolicy("local-first"); // still allowed: keeps going
      expect(stopped).not.toHaveBeenCalled();
      setAiPolicy("local-only");
    } else {
      localStorage.setItem("lumen.ai.policy", "local-only");
      window.dispatchEvent(new StorageEvent("storage", { key: "lumen.ai.policy", newValue: "local-only" }));
    }
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(document.getElementById("voice-recording-root")).toBeNull();
    setAiPolicy("local-only"); // the session is over: nothing more to stop
    expect(stopped).toHaveBeenCalledTimes(1);
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });
});

describe("local dictation start-up: cancellation and a suspended audio context (review: #197)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only");
    vi.resetModules();
  });

  function audioContext(opts: { state?: string; resume?: () => Promise<void> } = {}) {
    const close = vi.fn(async () => {});
    const made = vi.fn();
    const resume = vi.fn(opts.resume ?? (async () => {}));
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      state = opts.state ?? "running";
      sampleRate = 16000;
      destination = {};
      close = close;
      constructor() {
        made();
      }
      async resume() {
        await resume();
        this.state = "running";
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createScriptProcessor() {
        return { onaudioprocess: null, connect() {}, disconnect() {} };
      }
    };
    return { close, made, resume };
  }
  function mic(grant?: (give: (s: unknown) => void) => void) {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] };
    const getUserMedia = grant ? vi.fn(() => new Promise((r) => grant(r))) : vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    return { stop, stream };
  }
  const toastTexts = (calls: unknown[][], kind: string) => calls.filter((c) => c[1] === kind).map((c) => String(c[0]));
  afterEach(() => {
    vi.doUnmock("../ai/transformersEngine");
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    document.getElementById("voice-recording-root")?.remove();
  });

  it("Esc while the microphone prompt is open cancels it, and a microphone granted later is released", async () => {
    let give: ((s: unknown) => void) | null = null;
    const { stop, stream } = mic((g) => (give = g));
    const { made } = audioContext();
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { cancelAllAi } = await import("../ai/aiAbort");
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(give).not.toBeNull());
    expect(cancelAllAi()).toBe(1); // the dictation that is still starting can be cancelled
    give!(stream); // the user accepts the prompt afterwards
    await new Promise((r) => setTimeout(r, 0));
    expect(stop).toHaveBeenCalled();
    expect(made).not.toHaveBeenCalled();
    expect(document.getElementById("voice-recording-root")).toBeNull();
  });

  it("Esc while the speech engine is still loading releases the microphone at once", async () => {
    const { stop } = mic();
    const { close } = audioContext();
    let loaded: (() => void) | null = null;
    vi.doMock("../ai/transformersEngine", async () => {
      await new Promise<void>((r) => (loaded = r));
      return { transcribeAudio: vi.fn(async () => ({ text: "" })) };
    });
    const { showAiToast } = await import("../ui/AiToast");
    const toasts = showAiToast as unknown as ReturnType<typeof vi.fn>;
    const before = toasts.mock.calls.length;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { cancelAllAi } = await import("../ai/aiAbort");
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(loaded).not.toBeNull());
    expect(cancelAllAi()).toBe(1);
    expect(stop).toHaveBeenCalled(); // released while the import is still pending
    expect(close).toHaveBeenCalled();
    loaded!();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("voice-recording-root")).toBeNull();
    expect(toastTexts(toasts.mock.calls.slice(before), "info").some((m) => /Dictating on this device/.test(m))).toBe(false);
  });

  it("resumes a suspended audio context before it reports that dictation is on", async () => {
    mic();
    const { resume } = audioContext({ state: "suspended" });
    vi.doMock("../ai/transformersEngine", () => ({ transcribeAudio: vi.fn(async () => ({ text: "" })) }));
    const { showAiToast } = await import("../ui/AiToast");
    const toasts = showAiToast as unknown as ReturnType<typeof vi.fn>;
    const before = toasts.mock.calls.length;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { cancelAllAi } = await import("../ai/aiAbort");
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(toastTexts(toasts.mock.calls.slice(before), "info").some((m) => /Dictating on this device/.test(m))).toBe(true));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(document.getElementById("voice-recording-root")).not.toBeNull();
    cancelAllAi(); // stop the session
  });

  it("an audio context that won't resume releases the microphone and says so instead of recording silence", async () => {
    const { stop } = mic();
    const { close } = audioContext({ state: "suspended", resume: async () => Promise.reject(new DOMException("not allowed", "NotAllowedError")) });
    vi.doMock("../ai/transformersEngine", () => ({ transcribeAudio: vi.fn(async () => ({ text: "" })) }));
    const { showAiToast } = await import("../ui/AiToast");
    const toasts = showAiToast as unknown as ReturnType<typeof vi.fn>;
    const before = toasts.mock.calls.length;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { aiBusy } = await import("../ai/aiAbort");
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(toastTexts(toasts.mock.calls.slice(before), "error")).toHaveLength(1));
    expect(toastTexts(toasts.mock.calls.slice(before), "error")[0]).toMatch(/paused/);
    expect(stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(aiBusy()).toBe(false);
    expect(document.getElementById("voice-recording-root")).toBeNull();
    expect(toastTexts(toasts.mock.calls.slice(before), "info").some((m) => /Dictating on this device/.test(m))).toBe(false);
  });
});

describe("dictation setup and failures (review: #197)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  function fakeMic() {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
    return stop;
  }
  class FakeSR {
    static made = 0;
    lang = "";
    interimResults = false;
    continuous = false;
    onresult = null;
    onerror = null;
    onend = null;
    constructor() {
      FakeSR.made++;
    }
    start() {}
    stop() {}
  }
  it("releases the microphone when the audio graph cannot be built, then offers the fallback", async () => {
    localStorage.setItem("lumen.ai.policy", "cloud");
    const stopTrack = fakeMic();
    const close = vi.fn(async () => {});
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      sampleRate = 48000;
      close = close;
      createMediaStreamSource() {
        throw new Error("no audio graph");
      }
    };
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSR;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { uiConfirm } = await import("../ui/PromptDialog");
    (uiConfirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(uiConfirm).toHaveBeenCalled());
    expect(stopTrack).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it("re-reads the policy after the consent dialog: a switch to local-only in the meantime blocks the browser service", async () => {
    localStorage.setItem("lumen.ai.policy", "cloud");
    FakeSR.made = 0;
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSR;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { ledgerEntries } = await import("../ai/privacyLedger");
    const before = ledgerEntries().length;
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { uiConfirm } = await import("../ui/PromptDialog");
    (uiConfirm as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      localStorage.setItem("lumen.ai.policy", "local-only"); // e.g. from another tab
      return true;
    });
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(ledgerEntries().length).toBeGreaterThan(before));
    expect(FakeSR.made).toBe(0);
    expect(ledgerEntries().slice(before)).toEqual([expect.objectContaining({ decision: "blocked" })]);
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it("a failed transcription is reported once, releases the mic and offers the fallback", async () => {
    localStorage.setItem("lumen.ai.policy", "cloud");
    const stopTrack = fakeMic();
    let proc: { onaudioprocess: ((e: unknown) => void) | null } | null = null;
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      state = "running";
      sampleRate = 16000;
      destination = {};
      close = vi.fn(async () => {});
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createScriptProcessor() {
        proc = { onaudioprocess: null, connect() {}, disconnect() {} } as never;
        return proc;
      }
    };
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSR;
    vi.doMock("../ai/transformersEngine", () => ({ transcribeAudio: vi.fn(async () => Promise.reject(new Error("model download failed"))) }));
    const { showAiToast } = await import("./../ui/AiToast");
    const { startVoiceRecording } = await import("../ui/VoiceDictation");
    const { uiConfirm } = await import("../ui/PromptDialog");
    const confirms = (uiConfirm as unknown as ReturnType<typeof vi.fn>);
    const toasts = showAiToast as unknown as ReturnType<typeof vi.fn>;
    const confirmsBefore = confirms.mock.calls.length;
    const toastsBefore = toasts.mock.calls.length;
    confirms.mockResolvedValueOnce(false);
    startVoiceRecording("en-US");
    await vi.waitFor(() => expect(proc?.onaudioprocess).toBeTruthy());
    const loud = new Float32Array(16000 * 5).fill(0.3);
    for (let i = 0; i < 3; i++) proc!.onaudioprocess!({ inputBuffer: { getChannelData: () => loud } }); // three segments, all fail
    await vi.waitFor(() => expect(confirms.mock.calls.length).toBe(confirmsBefore + 1));
    await new Promise((r) => setTimeout(r, 20)); // the other two segments settle
    expect(confirms.mock.calls.length).toBe(confirmsBefore + 1);
    const errors = toasts.mock.calls.slice(toastsBefore).filter((c) => c[1] === "error");
    expect(errors).toHaveLength(1);
    // One toast, in words (explainError), not the engine's own text.
    expect(String(errors[0][0])).toContain(t("error.unknown"));
    expect(String(errors[0][0])).not.toContain("model download failed");
    expect(stopTrack).toHaveBeenCalled();
    vi.doUnmock("../ai/transformersEngine");
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    document.getElementById("voice-recording-root")?.remove();
  });
});
