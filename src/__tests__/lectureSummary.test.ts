/**
 * Audit W10.C9 (plan W5.13 step 3, plan 6.11): student mode registers the
 * checked summarizer. A local model's summary, checked by the summarizer
 * agent's `grounded` validator and again by `verifySummary`, is used, and
 * the note says "checked". Without a model, or when the check fails, the
 * extractive summary is kept and the note says "extractive".
 *
 * The lecture's transcript is synthetic: six Hebrew sentences written for
 * this test. Whisper is a fixed stand-in for that transcript, and the
 * workspace is an in-memory map. The agent runtime, the summarizer agent,
 * its validator, the index mapping and processLecture are the real code.
 * The model is a scripted executor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const files = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../storage/workspace", () => ({
  writeWorkspaceBlob: async (p: string, b: unknown) => void files.set(p, b),
  writeWorkspaceFile: async (p: string, t: string) => void files.set(p, t),
}));
vi.mock("../storage/workspaceEvents", () => ({ notifyWorkspaceChanged: () => {} }));
const SENTENCES = [
  "התא הוא היחידה הבסיסית של החיים.",
  "לכל תא יש קרום שמפריד בינו לבין הסביבה.",
  "בגרעין נמצא החומר התורשתי של התא.",
  "המיטוכונדריה מייצרת את רוב האנרגיה של התא.",
  "בתאי צמחים יש גם דופן תא וכלורופלסטים.",
  "בשיעור הבא נדבר על חלוקת התא.",
];
vi.mock("../ai/transformersEngine", () => ({
  decodeAudioTo16k: async () => new Float32Array(16),
  transcribeAudio: async () => ({ text: SENTENCES.join(" "), segments: SENTENCES.map((text, i) => ({ start: i * 10, end: i * 10 + 9, text })) }),
  ortBaseUrl: () => "",
}));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { processLecture, setLectureSummarizer } from "../student/lecture";
import { registerLectureSummarizer, sentencesOfSummary } from "../student/lectureSummarizer";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { fakeExecutor, reply } from "./helpers/fakeExecutor";

const run = () => processLecture(new Blob(["x"], { type: "audio/webm" }), { durationMs: 60_000, markers: [], title: "ביולוגיה", language: "he", when: new Date(2026, 10, 14, 10, 0) });
const note = (path: string) => files.get(path) as string;

beforeEach(() => {
  files.clear();
  resetExecutors();
  localStorage.setItem("lumen.ai.cache", "off");
});
afterEach(() => setLectureSummarizer(null));

describe("the checked lecture summary (W10.C9)", () => {
  it("a local model's grounded summary is used, and the note says it is checked", async () => {
    // The model copies two sentences, one of them shortened with "…".
    registerExecutor(fakeExecutor(() => reply("המיטוכונדריה מייצרת את רוב האנרגיה של התא.\nבגרעין נמצא … החומר התורשתי של התא.")));
    registerLectureSummarizer(undefined, "he-IL");
    const res = await run();
    expect(res.summary).toBe("checked");
    const md = note(res.path);
    const summary = md.split("## Summary")[1].split("## ")[0];
    expect(summary).toContain("_Checked summary");
    expect(summary).toContain("המיטוכונדריה מייצרת את רוב האנרגיה של התא.");
    expect(summary).toContain("בגרעין נמצא החומר התורשתי של התא.");
    expect(summary).not.toContain("בשיעור הבא");
  });

  it("a summary the check rejects (sentences not in the lecture) leaves the extractive one, labelled", async () => {
    registerExecutor(fakeExecutor(() => reply("התאים הם אבני הבניין של כל היצורים.\nהאנרגיה מגיעה מהשמש.")));
    registerLectureSummarizer(undefined, "he");
    const res = await run();
    expect(res.summary).toBe("extractive");
    expect(note(res.path)).toContain("_Extractive summary");
    expect(note(res.path)).not.toContain("אבני הבניין");
  });

  it("no local model: the extractive summary, labelled", async () => {
    registerLectureSummarizer(undefined, "he");
    const res = await run();
    expect(res.summary).toBe("extractive");
    expect(note(res.path)).toContain("_Extractive summary");
  });

  it("a summary line maps to the sentence it was copied from, shortened or not; other lines are dropped", () => {
    const s = SENTENCES.map((text, i) => ({ start: i, end: i + 1, text }));
    expect(sentencesOfSummary(["בתאי צמחים … כלורופלסטים.", "התא הוא היחידה הבסיסית של החיים.", "לא נאמר בשיעור.", "התא הוא היחידה הבסיסית של החיים."], s)).toEqual([4, 0]);
  });
});
