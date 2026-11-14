import { describe, it, expect, vi } from "vitest";

vi.mock("../store/useStore", () => ({
  useAppStore: {
    getState: vi.fn().mockReturnValue({
      aiKey: null,
      useLocalAi: false,
      doc: { content: "" },
      setContent: vi.fn(),
    }),
  },
}));
vi.mock("./AiToast", () => ({
  showAiToast: vi.fn(),
}));
vi.mock("../ui/AiToast", () => ({
  showAiToast: vi.fn(),
}));
vi.mock("../i18n", () => ({ registerEnglish: () => undefined, t: (k: string, p?: Record<string, string>) => {
  if (p) return Object.entries(p).reduce((s, [k2, v]) => s.replace(`{${k2}}`, v), k);
  return k;
}}));
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../ai/transcribe", () => ({
  transcribe: vi.fn().mockResolvedValue({ text: "hello", backend: "cloud", ms: 500 }),
  summarizeMemo: vi.fn().mockResolvedValue("• summary bullet"),
  formatVoiceMemo: vi.fn().mockReturnValue("> 🎙 Voice memo\n\n> Summary"),
}));

describe("VoiceDictation module exports", () => {
  it("exports startVoiceRecording function", async () => {
    const mod = await import("../ui/VoiceDictation");
    expect(typeof mod.startVoiceRecording).toBe("function");
  });

  it("exports startVoiceMemo function", async () => {
    const mod = await import("../ui/VoiceDictation");
    expect(typeof mod.startVoiceMemo).toBe("function");
  });

  it("browser speech shows an error toast when SpeechRecognition is unavailable", async () => {
    const { showAiToast } = await import("../ui/AiToast") as any;
    const { startBrowserSpeech } = await import("../ui/VoiceDictation");
    const { setAiPolicy } = await import("../ai/policy");
    setAiPolicy("local-first");
    const original = (window as any).SpeechRecognition;
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
    // The browser's speech service runs only under the cloud policy (plan 6.17).
    localStorage.setItem("lumen.ai.policy", "cloud");
    startBrowserSpeech("en");
    expect(showAiToast).toHaveBeenCalledWith(
      expect.stringMatching(/not supported|NotSupported/i),
      "error",
    );
    localStorage.removeItem("lumen.ai.policy");
    if (original) (window as any).SpeechRecognition = original;
    localStorage.clear();
  });

  it("never starts browser speech under local-only (1.3), and records the refusal", async () => {
    const { showAiToast } = await import("../ui/AiToast") as any;
    const { startBrowserSpeech } = await import("../ui/VoiceDictation");
    const { setAiPolicy } = await import("../ai/policy");
    const { ledgerEntries } = await import("../ai/privacyLedger");
    setAiPolicy("local-only");
    const ctor = vi.fn();
    (window as any).SpeechRecognition = ctor;
    startBrowserSpeech("he-IL");
    expect(ctor).not.toHaveBeenCalled();
    expect(showAiToast).toHaveBeenCalledWith("dictation.localOnlyNoBrowser", "error");
    expect(ledgerEntries().at(-1)).toMatchObject({ category: "cloud-ai", decision: "blocked", policy: "local-only" });
    delete (window as any).SpeechRecognition;
    localStorage.clear();
  });

  it("startVoiceMemo shows error toast when MediaRecorder unavailable", async () => {
    const { showAiToast } = await import("../ui/AiToast") as any;
    const { startVoiceMemo } = await import("../ui/VoiceDictation");
    const original = (window as any).MediaRecorder;
    (window as any).MediaRecorder = undefined;
    await startVoiceMemo();
    expect(showAiToast).toHaveBeenCalledWith(
      expect.stringMatching(/not supported|NotSupported/i),
      "error",
    );
    if (original) (window as any).MediaRecorder = original;
  });
});
