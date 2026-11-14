/**
 * Plan W1.13 — voice capture into the inbox: the title from the first 80
 * characters, the attachment name and link with its time range, the
 * transcriber seam (plan 6.1 plugs in there), and the capture itself.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const writes: Array<[string, unknown]> = [];
const captured: string[] = [];
vi.mock("../storage/workspace", () => ({ writeWorkspaceBlob: vi.fn(async (p: string, d: unknown) => void writes.push([p, d])) }));
vi.mock("../storage/workspaceEvents", () => ({ notifyWorkspaceChanged: vi.fn() }));
vi.mock("../capture/quickCapture", () => ({ captureToInbox: vi.fn(async (text: string) => (captured.push(text), "inbox.md")) }));

import { attachmentPath, captureVoice, clock, setVoiceTranscriber, titleFromTranscript, transcribeVoice, voiceEntryText } from "../capture/voiceCapture";
import { parseLaunch } from "../pwa/launch";

afterEach(() => {
  setVoiceTranscriber(null);
  writes.length = 0;
  captured.length = 0;
});

describe("voice capture (W1.13)", () => {
  it("the title is the first 80 characters, cut at a word", () => {
    expect(titleFromTranscript("Call Dana about the budget.")).toBe("Call Dana about the budget");
    const long = "להתקשר לדנה לגבי התקציב של הרבעון הבא ולבדוק אם אפשר להזיז את הפגישה עם הספק לשבוע שאחרי החג";
    const t = titleFromTranscript(long);
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(81);
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
    expect(t.slice(0, -1).endsWith(" ")).toBe(false);
  });

  it("attachment name: date, time and the title's words; any script", () => {
    const when = new Date(2026, 10, 10, 9, 5);
    expect(attachmentPath(when, "Call Dana: budget?")).toBe("attachments/voice-2026-11-10-0905-Call-Dana-budget.webm");
    expect(attachmentPath(when, "פגישה עם רון…", "m4a")).toBe("attachments/voice-2026-11-10-0905-פגישה-עם-רון.m4a");
    expect(attachmentPath(when, "")).toBe("attachments/voice-2026-11-10-0905.webm");
  });

  it("entry text: bold title for a long transcript, a placeholder without one, and a link to the recording's time range", () => {
    expect(voiceEntryText("Short one", { placeholder: "P" })).toBe("Short one");
    const long = "word ".repeat(30).trim();
    expect(voiceEntryText(long, { placeholder: "P" }).split("\n")[0]).toMatch(/^\*\*word( word)+…\*\*$/);
    expect(voiceEntryText(null, { placeholder: "Voice note", audioPath: "attachments/a.webm", durationMs: 61_400 })).toBe("Voice note\n[▶ 0:00–1:01](<attachments/a.webm#t=0,61>)");
    expect(clock(125_000)).toBe("2:05");
  });

  it("the transcriber seam is used when set (plan 6.1's live dictation registers there)", async () => {
    const fn = vi.fn(async () => "שלום עולם");
    setVoiceTranscriber(fn);
    const blob = new Blob(["x"], { type: "audio/webm" });
    expect(await transcribeVoice(blob, { language: "he" })).toBe("שלום עולם");
    expect(fn).toHaveBeenCalledWith(blob, { language: "he" });
  });

  it("captureVoice saves the audio first, then adds the entry to the inbox", async () => {
    const audio = new Blob(["abc"], { type: "audio/webm;codecs=opus" });
    const when = new Date(2026, 10, 10, 14, 30);
    expect(await captureVoice("Buy milk", { placeholder: "P", audio, durationMs: 3200, when })).toBe("inbox.md");
    expect(writes).toEqual([["attachments/voice-2026-11-10-1430-Buy-milk.webm", audio]]);
    expect(captured).toEqual(["Buy milk\n[▶ 0:00–0:03](<attachments/voice-2026-11-10-1430-Buy-milk.webm#t=0,3>)"]);
    await captureVoice("Text only", { placeholder: "P" });
    expect(writes).toHaveLength(1);
    expect(captured[1]).toBe("Text only");
  });

  it("/?capture=voice opens the box recording", () => {
    expect(parseLaunch("?capture=voice")).toEqual({ kind: "action", action: "voice" });
    expect(parseLaunch("?capture=1")).toEqual({ kind: "action", action: "capture" });
  });
});
