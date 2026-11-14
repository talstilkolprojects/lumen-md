/**
 * A long recording's transcript as Markdown (plan W1.17): one line per
 * sentence, each starting with its time as a link that plays the audio from
 * there — `[▶ 12:04](<attachments/talk.m4a#t=724,731>)` (a media fragment,
 * the same form quick capture uses for voice notes).
 *
 * Whisper's segments (whisper.cpp SRT cues, or transformers.js chunks) do not
 * follow sentences: one segment can hold two sentences, one sentence can span
 * three segments. Segments are joined, then split after . ? ! … (also the
 * Hebrew ׃ and the full stop of other scripts); a split inside a segment gets
 * a time in proportion to the characters before it.
 *
 * Pure: no audio, no I/O.
 */
import type { TimedSegment } from "../transformersEngine";

export type WhisperOut = { text?: string; language?: string; chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }> };

/**
 * One window's `return_timestamps` chunks → segments on the whole file's
 * clock (`offset` = where the window starts, s). A chunk Whisper left open
 * (end null) ends at the next chunk's start or at the window's end.
 */
export function timedChunks(out: WhisperOut | undefined, offset: number, length: number): TimedSegment[] {
  const chunks = out?.chunks ?? [];
  const res: TimedSegment[] = [];
  chunks.forEach((c, i) => {
    const text = (c.text ?? "").trim();
    if (!text) return;
    const start = Math.min(Math.max(c.timestamp?.[0] ?? 0, 0), length);
    const nextStart = chunks[i + 1]?.timestamp?.[0];
    const end = Math.min(Math.max(c.timestamp?.[1] ?? nextStart ?? length, start), length);
    res.push({ start: offset + start, end: offset + end, text });
  });
  return res;
}

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

const END = /[.?!…׃。？！]["'”’»)\]]*$/u;

/** "0:07", "12:04", "1:02:03" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Split one segment's text after sentence ends → pieces with proportional times. */
function pieces(seg: TimedSegment): Sentence[] {
  const text = seg.text.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const words = text.split(" ");
  const out: Sentence[] = [];
  const span = Math.max(0, seg.end - seg.start);
  let from = 0; // chars consumed before the current piece
  let buf: string[] = [];
  const total = text.length;
  const flush = (upto: number) => {
    if (!buf.length) return;
    const piece = buf.join(" ");
    out.push({ start: seg.start + (span * from) / total, end: seg.start + (span * Math.min(upto, total)) / total, text: piece });
    from = upto + 1;
    buf = [];
  };
  let pos = 0;
  for (const w of words) {
    buf.push(w);
    pos += w.length;
    if (END.test(w)) flush(pos);
    pos += 1;
  }
  flush(total);
  return out;
}

/**
 * Timed segments → sentences. A sentence that runs past a segment boundary
 * keeps the first piece's start and the last piece's end. A trailing
 * fragment without an end mark is a sentence of its own. `maxSeconds` caps a
 * run-on "sentence" (speech without punctuation) so a link still lands near
 * what it points to.
 */
export function sentencesOf(segments: readonly TimedSegment[], maxSeconds = 30): Sentence[] {
  const out: Sentence[] = [];
  let open: Sentence | null = null;
  for (const seg of [...segments].sort((a, b) => a.start - b.start)) {
    for (const p of pieces(seg)) {
      if (open && open.end - open.start + (p.end - p.start) > maxSeconds) {
        out.push(open);
        open = null;
      }
      open = open ? { start: open.start, end: p.end, text: `${open.text} ${p.text}` } : { ...p };
      if (END.test(p.text)) {
        out.push(open);
        open = null;
      }
    }
  }
  if (open) out.push(open);
  return out;
}

/** `#t=724,731` — whole seconds, end rounded up so the sentence is not cut. */
export function timeFragment(s: Sentence): string {
  const a = Math.max(0, Math.floor(s.start));
  const b = Math.max(a + 1, Math.ceil(s.end));
  return `#t=${a},${b}`;
}

/**
 * Markdown, one sentence per line. With `audioPath` (a vault path) each time
 * is a link that plays from there; without one, the time is plain text.
 */
export function transcriptMarkdown(sentences: readonly Sentence[], audioPath?: string | null): string {
  return sentences
    .map((s) => {
      const time = clock(s.start);
      const stamp = audioPath ? `[▶ ${time}](<${audioPath}${timeFragment(s)}>)` : `\`${time}\``;
      return `${stamp} ${s.text}`;
    })
    .join("\n");
}
