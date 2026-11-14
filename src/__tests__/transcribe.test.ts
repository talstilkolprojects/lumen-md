/**
 * Tests for the voice-memo transcription module (γ.4 / F2).
 *
 * The local backend (transformers.js in a worker) is mocked through
 * `../ai/transformersEngine`. The cloud backend hits OpenAI's
 * `/v1/audio/transcriptions`; it is used under the `cloud` policy or as
 * the `local-first` fallback. We mock `fetch` and `useAppStore` to drive
 * both paths deterministically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "../store/useStore";
import { transcribe, summarizeMemo, formatVoiceMemo } from "../ai/transcribe";

const decode = vi.fn(async (_b: Blob) => new Float32Array(16_000));
const local = vi.fn(async (_s: Float32Array, _o: unknown) => ({ text: " local text ", language: "he" }));
vi.mock("../ai/transformersEngine", () => ({
  decodeAudioTo16k: (b: Blob) => decode(b),
  transcribeAudio: (s: Float32Array, o: unknown) => local(s, o),
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  decode.mockClear();
  local.mockClear();
  // Reset Privacy Mode + AI key between tests; cloud tests pin the cloud policy.
  useAppStore.setState({ useLocalAi: false, aiKey: "sk-test" });
  localStorage.setItem("lumen.ai.policy", "cloud");
});

describe("transcribe — forced local (dictation's recorded fallback, plan 6.1)", () => {
  it("never reaches the cloud under the cloud policy", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await transcribe(new Blob(["x"], { type: "audio/webm" }), { language: "en", local: true });
    expect(result).toMatchObject({ text: "local text", backend: "local" });
    expect(local).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("fails instead of falling back to the cloud under local-first", async () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    local.mockRejectedValueOnce(new Error("no wasm"));
    await expect(transcribe(new Blob(["x"]), { local: true })).rejects.toThrow(/no wasm/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("transcribe — cloud backend", () => {
  it("POSTs the blob to OpenAI Whisper and returns the trimmed text", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "  hello world  " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const blob = new Blob(["fake-audio"], { type: "audio/webm" });

    const result = await transcribe(blob);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(result.text).toBe("hello world");
    expect(result.backend).toBe("cloud");
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("forwards the language hint when provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "x" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await transcribe(new Blob(["x"], { type: "audio/webm" }), { language: "fr" });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get("language")).toBe("fr");
    expect(form.get("model")).toBe("whisper-1");
  });

  it("throws AiError on a non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate-limited", { status: 429 })),
    );
    await expect(transcribe(new Blob(["x"]))).rejects.toThrow(/Whisper failed \(429\)/);
  });

  it("throws AiError when AI key is missing", async () => {
    useAppStore.setState({ aiKey: null });
    await expect(transcribe(new Blob(["x"]))).rejects.toThrow(/configure your AI Key/i);
  });
});

describe("transcribe — local backend (transformers.js)", () => {
  it("is the default: decodes to 16 kHz and transcribes in the worker, reducing the language tag", async () => {
    localStorage.setItem("lumen.ai.policy", "local-only");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await transcribe(new Blob(["x"], { type: "audio/webm" }), { language: "he-IL" });
    expect(result).toMatchObject({ text: "local text", backend: "local" });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(local.mock.calls[0][1]).toMatchObject({ language: "he" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("under local-only a local failure is final; under local-first the cloud takes over", async () => {
    local.mockRejectedValueOnce(new Error("no gpu"));
    localStorage.setItem("lumen.ai.policy", "local-only");
    await expect(transcribe(new Blob(["x"]))).rejects.toThrow("no gpu");
    local.mockRejectedValueOnce(new Error("no gpu"));
    localStorage.setItem("lumen.ai.policy", "local-first");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "cloud text" }), { status: 200 })));
    expect(await transcribe(new Blob(["x"]))).toMatchObject({ text: "cloud text", backend: "cloud" });
  });

  it("rejects an empty recording before loading any model", async () => {
    localStorage.setItem("lumen.ai.policy", "local-only");
    decode.mockResolvedValueOnce(new Float32Array(0));
    await expect(transcribe(new Blob([]))).rejects.toThrow(/empty/);
    expect(local).not.toHaveBeenCalled();
  });
});

describe("formatVoiceMemo", () => {
  it("emits a `> 🎙 Voice memo` quote with date + summary + collapsible transcript", () => {
    const out = formatVoiceMemo({
      transcript: "Long transcript body",
      summary: "- bullet one\n- bullet two",
      date: new Date("2026-04-28T10:30:00Z"),
      backend: "cloud",
    });
    expect(out).toMatch(/> 🎙 Voice memo · 2026-04-28 10:30/);
    expect(out).toContain("- bullet one");
    expect(out).toContain("<details><summary>Full transcript</summary>");
    expect(out).toContain("Long transcript body");
    expect(out).toContain("</details>");
  });

  it("appends a 🛡 local marker when the local backend was used", () => {
    const out = formatVoiceMemo({
      transcript: "x",
      summary: "y",
      date: new Date("2026-04-28T10:30:00Z"),
      backend: "local",
    });
    expect(out).toContain("🛡 local");
  });

  it("falls back to '_(no summary available)_' when summary is empty", () => {
    const out = formatVoiceMemo({
      transcript: "x",
      summary: "",
      date: new Date("2026-04-28T10:30:00Z"),
      backend: "cloud",
    });
    expect(out).toContain("_(no summary available)_");
  });
});

describe("summarizeMemo", () => {
  it("returns empty string for empty transcripts (no API call)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await summarizeMemo("");
    expect(out).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
