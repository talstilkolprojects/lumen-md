/**
 * Plan 6.16 — meeting notes on this device (lazy). The transcript (the
 * voice memo's local Whisper, or text already in the note) goes to the
 * `meeting-writer` agent through the runtime — on a local model under the
 * local-only policy — and comes back as decisions, tasks and open
 * questions. Tasks become `- [ ]` lines the vault's task panel (4.13)
 * shows; dated ones can be saved as an .ics calendar file.
 */
import { formatMeetingNote, normalizeNotes, tasksToIcs, type MeetingNotes } from "./meetingCore";
import { t } from "../i18n";

export interface MeetingResult {
  notes: MeetingNotes;
  markdown: string;
  /** The calendar of dated tasks, or null. */
  ics: string | null;
}

const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Meeting notes from a transcript (`date`: the meeting's day, default today). */
export async function meetingNotesFrom(transcript: string, opts: { signal?: AbortSignal; date?: string; local?: boolean } = {}): Promise<MeetingResult> {
  const date = opts.date ?? today();
  const [{ runAgentOrThrow }, { meetingWriterAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
  const raw = await runAgentOrThrow(meetingWriterAgent, { text: transcript, extra: { date } }, { signal: opts.signal, document: transcript, ownPrompt: true });
  const notes = normalizeNotes(raw);
  const markdown = formatMeetingNote(notes, {
    date,
    transcript,
    local: opts.local ?? false,
    labels: { title: t("meeting.title"), decisions: t("meeting.decisions"), tasks: t("meeting.tasks"), questions: t("meeting.questions"), none: t("meeting.none"), transcript: t("meeting.transcript") },
  });
  const ics = tasksToIcs(notes.tasks, { title: `${t("meeting.title")} ${date}`, stamp: new Date(), uidSeed: `meeting-${date}-${Date.now().toString(36)}` });
  return { notes, markdown, ics };
}

/** Offer the calendar file of the dated tasks (asks first). */
export async function offerIcs(result: MeetingResult): Promise<void> {
  if (!result.ics) return;
  const n = result.notes.tasks.filter((x) => x.due).length;
  const { uiConfirm } = await import("../ui/PromptDialog");
  if (!(await uiConfirm({ message: t("meeting.icsOffer", { n }) }))) return;
  const url = URL.createObjectURL(new Blob([result.ics], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `meeting-${today()}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
