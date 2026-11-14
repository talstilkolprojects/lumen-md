/**
 * Student mode (plan W5.13), the app side: save the recording, transcribe
 * it on this device with local Whisper (never a cloud service, under every
 * AI policy), and write the lecture note: summary, cards, timed transcript.
 * The summary goes through a seam (`setLectureSummarizer`): plan 6.11's
 * checked local summarizer (./lectureSummarizer.ts, registered by the
 * recorder) picks it; whatever it returns must be sentences of the
 * transcript, or the extractive summary is kept. The note and the result
 * say which one it is (`summary: "checked" | "extractive"`).
 */
import "./strings";
import { t } from "../i18n";
import { cardsFrom, extractiveSummary, importantOf, lectureNote, sentencesOf, verifySummary, type Lecture, type TimedText } from "./lectureCore";

export const LECTURES_DIR = "Lectures";

/** Picks summary sentences (indices into `sentences`); plan 6.11 may register one. */
export type LectureSummarizer = (sentences: readonly TimedText[], important: ReadonlySet<number>, signal?: AbortSignal) => Promise<number[]>;
let summarizer: LectureSummarizer | null = null;
export function setLectureSummarizer(fn: LectureSummarizer | null): void {
  summarizer = fn;
}

/** Which summary the lecture got: the checked model summary, or the extractive one. */
export type SummaryKind = "checked" | "extractive";

export interface LectureProgress {
  step: "saving" | "transcribing" | "writing";
}

const pad = (n: number) => String(n).padStart(2, "0");
const extOf = (mime: string) => (/mp4/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm");

export function lecturePaths(when: Date, title: string, mime: string): { note: string; audio: string; audioLink: string } {
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  const safe = title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Lecture";
  const file = `lecture-${stamp.replace(" ", "-")}.${extOf(mime)}`;
  // The note links its audio relative to itself (audio/ beside the note).
  return { note: `${LECTURES_DIR}/${stamp} ${safe}.md`, audio: `${LECTURES_DIR}/audio/${file}`, audioLink: `audio/${file}` };
}

/** From the stopped recording to the lecture note; resolves to the note's path and what it holds. */
export async function processLecture(audio: Blob, opts: { durationMs: number; markers: number[]; title: string; language?: string; when?: Date; signal?: AbortSignal; onProgress?: (p: LectureProgress) => void }): Promise<{ path: string; sentences: number; important: number; cards: number; ms: number; summary: SummaryKind }> {
  const t0 = performance.now();
  const when = opts.when ?? new Date();
  const [{ writeWorkspaceBlob, writeWorkspaceFile }, { notifyWorkspaceChanged }, engine] = await Promise.all([import("../storage/workspace"), import("../storage/workspaceEvents"), import("../ai/transformersEngine")]);
  const paths = lecturePaths(when, opts.title, audio.type);
  opts.onProgress?.({ step: "saving" });
  await writeWorkspaceBlob(paths.audio, audio);
  opts.onProgress?.({ step: "transcribing" });
  const samples = await engine.decodeAudioTo16k(audio);
  const language = opts.language ? opts.language.split(/[-_]/)[0].toLowerCase() : undefined;
  const out = await engine.transcribeAudio(samples, { language, signal: opts.signal, timestamps: true });
  const durationSec = opts.durationMs / 1000;
  const segments = out.segments?.length ? out.segments : out.text ? [{ start: 0, end: durationSec, text: out.text }] : [];
  const sentences = sentencesOf(segments);
  const important = importantOf(sentences, opts.markers);
  let summary = extractiveSummary(sentences, important);
  let summaryKind: SummaryKind = "extractive";
  if (summarizer) {
    const picked = await summarizer(sentences, important, opts.signal).catch(() => null);
    if (picked?.length && picked.every((i) => sentences[i]) && verifySummary(picked.map((i) => sentences[i].text), sentences.map((s) => s.text).join(" "))) {
      summary = picked;
      summaryKind = "checked";
    }
  }
  const lecture: Lecture = { title: opts.title, date: when.toISOString().slice(0, 10), audioPath: paths.audioLink, durationSec, sentences, important, summary, cards: cardsFrom(sentences, important, paths.audioLink) };
  opts.onProgress?.({ step: "writing" });
  await writeWorkspaceFile(paths.note, lectureNote(lecture, { recording: t("student.recording"), summary: t("student.summary"), summaryKind: t(summaryKind === "checked" ? "student.summary.checked" : "student.summary.extractive"), cards: t("student.cards"), noCards: t("student.noCards"), transcript: t("student.transcript"), important: t("student.important") }));
  notifyWorkspaceChanged({ kind: "structure", paths: [paths.audio, paths.note] });
  return { path: paths.note, sentences: sentences.length, important: important.size, cards: lecture.cards.length, ms: Math.round(performance.now() - t0), summary: summaryKind };
}
