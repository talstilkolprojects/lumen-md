/**
 * Student mode (plan W5.13): a recorded lecture → a transcript with a ▶ for
 * every sentence → a summary whose every sentence is copied from the
 * transcript → review cards (FSRS, W3.3's `question :: answer` lines) made
 * from the moments the student marked "important!", each linked to that
 * moment in the recording. The pure part (no app imports); the app side
 * is ./lecture.ts.
 */

export interface TimedText {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
}

/** h:mm:ss or m:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A ▶ link to a moment of the recording (a media fragment, as voice capture writes them). */
export function playLink(audioPath: string, at: TimedText): string {
  return `[▶ ${clock(at.start)}](<${audioPath}#t=${Math.floor(at.start)},${Math.ceil(at.end)}>)`;
}

/**
 * Split timed segments into sentences (. ! ? … and their Hebrew use), the
 * segment's time shared out by length, so each sentence gets its own ▶.
 */
export function sentencesOf(segments: readonly TimedText[]): TimedText[] {
  const out: TimedText[] = [];
  for (const seg of segments) {
    const parts = seg.text.match(/[^.!?…]+[.!?…]+["'”׳״)]*|[^.!?…]+$/g)?.map((p) => p.trim()).filter(Boolean) ?? [];
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = seg.start;
    for (const p of parts) {
      const d = ((seg.end - seg.start) * p.length) / total;
      out.push({ start: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100, text: p });
      t += d;
    }
  }
  return out;
}

/**
 * Sentences marked important: a tap at time T marks what was said in the
 * `before` seconds up to it and the `after` seconds after (a student taps
 * when they hear it, a moment late).
 */
export function importantOf(sentences: readonly TimedText[], markers: readonly number[], before = 20, after = 5): Set<number> {
  const out = new Set<number>();
  for (const m of markers) sentences.forEach((s, i) => s.end >= m - before && s.start <= m + after && out.add(i));
  return out;
}

const STOP = new Set(
  "של את על עם זה זו זאת הוא היא הם הן אני אנחנו אתם יש אין לא כן גם רק כל אבל או אם כי מה מי איך כמו עוד כבר מאוד היה היתה היו להיות שלו שלה שלהם אותו אותה אז פה כאן שם יותר פחות בין אחרי לפני כאשר כדי ככה בעצם כלומר בסדר טוב the a an and or of to in on for with is are was were be been it this that these those as at by from we you they he she i not but so if then than there their our your can will would should could also just very about into over more most such which what who how when where why"
    .split(" "),
);
const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+(?:['’״"][\p{L}]+)?/gu) ?? [];

/**
 * An extractive summary: the marked sentences first, then the most central
 * ones (word overlap with the rest of the lecture), in the order spoken.
 * Every sentence is copied verbatim, so `verifySummary` can check it.
 */
export function extractiveSummary(sentences: readonly TimedText[], important: ReadonlySet<number>, max = 8): number[] {
  const df = new Map<string, number>();
  for (const s of sentences) for (const w of new Set(wordsOf(s.text))) if (!STOP.has(w) && w.length > 2) df.set(w, (df.get(w) ?? 0) + 1);
  const score = sentences.map((s, i) => {
    const ws = wordsOf(s.text).filter((w) => !STOP.has(w) && w.length > 2);
    const central = ws.reduce((n, w) => n + Math.log(1 + (df.get(w) ?? 0)), 0) / Math.sqrt(ws.length || 1);
    return { i, score: (important.has(i) ? 100 : 0) + central - (ws.length < 4 ? 50 : 0) };
  });
  return score
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.i)
    .sort((a, b) => a - b);
}

/** Every summary sentence is in the transcript word for word (whitespace aside). */
export function verifySummary(summary: readonly string[], transcript: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const all = squash(transcript);
  return summary.every((s) => all.includes(squash(s)));
}

export interface LectureCard {
  front: string;
  back: string;
  /** The moment it came from. */
  at: TimedText;
}

/**
 * A cloze card from a sentence: its most telling word (the longest that is
 * not a stop word, preferring a number or a term the lecture repeats) is
 * blanked; the back is the word and a ▶ to the moment.
 */
export function clozeCard(s: TimedText, audioPath: string, df: ReadonlyMap<string, number> = new Map()): LectureCard | null {
  const ws = (s.text.match(/[\p{L}\p{N}]+(?:['’״"][\p{L}]+)?/gu) ?? []).filter((w) => !STOP.has(w.toLowerCase()) && w.length >= 3);
  if (ws.length < 3) return null;
  const pick = [...ws].sort((a, b) => (df.get(b.toLowerCase()) ?? 0) - (df.get(a.toLowerCase()) ?? 0) || Number(/\d/.test(b)) - Number(/\d/.test(a)) || b.length - a.length)[0];
  const front = s.text.replace(pick, "____").replace(/::/g, ":").trim();
  if (!front.includes("____")) return null;
  return { front, back: `${pick} — ${playLink(audioPath, s)}`, at: s };
}

export function cardsFrom(sentences: readonly TimedText[], important: ReadonlySet<number>, audioPath: string): LectureCard[] {
  const df = new Map<string, number>();
  for (const s of sentences) for (const w of new Set(wordsOf(s.text))) df.set(w, (df.get(w) ?? 0) + 1);
  return [...important].sort((a, b) => a - b).map((i) => clozeCard(sentences[i], audioPath, df)).filter((c): c is LectureCard => !!c);
}

export interface LectureWords {
  recording: string;
  summary: string;
  cards: string;
  noCards: string;
  transcript: string;
  important: string;
}

export interface Lecture {
  title: string;
  date: string;
  audioPath: string;
  durationSec: number;
  sentences: TimedText[];
  important: Set<number>;
  summary: number[];
  cards: LectureCard[];
}

/** A transcript line must not read as a card (`::`) to the review queue. */
const plain = (t: string) => t.replace(/::/g, ":");

/** The lecture note: summary, cards (W3.3 reads `front :: back`), and the timed transcript. */
export function lectureNote(l: Lecture, w: LectureWords): string {
  const lines = [
    "---",
    `lecture-date: ${l.date}`,
    `lecture-audio: ${JSON.stringify(l.audioPath)}`,
    `lecture-duration: ${JSON.stringify(clock(l.durationSec))}`,
    "tags: [lecture]",
    "---",
    "",
    `# ${l.title}`,
    "",
    `${w.recording}: [▶ 0:00–${clock(l.durationSec)}](<${l.audioPath}>)`,
    "",
    `## ${w.summary}`,
    "",
    ...l.summary.map((i) => `- ${plain(l.sentences[i].text)} ${playLink(l.audioPath, l.sentences[i])}`),
    "",
    `## ${w.cards}`,
    "",
    ...(l.cards.length ? l.cards.map((c) => `- ${c.front} :: ${c.back}`) : [`_${w.noCards}_`]),
    "",
    `## ${w.transcript}`,
    "",
    ...l.sentences.map((s, i) => `${playLink(l.audioPath, s)} ${l.important.has(i) ? `**⭐ ${w.important}** ` : ""}${plain(s.text)}`),
    "",
  ];
  return lines.join("\n");
}
