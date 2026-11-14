/**
 * Who spoke when (plan W2.7) — the pure parts of speaker diarization in
 * the shape of pyannote speaker-diarization 3.1: a segmentation model scores
 * each ~17 ms frame of a 10 s window for up to 3 local speakers (the
 * "powerset" output: none, one speaker, or a pair), every local speaker of
 * every window gets a voice embedding, the embeddings are clustered into the
 * meeting's speakers, and the frames become turns. Then each transcript
 * segment (W1.17) gets the speaker it overlaps most.
 *
 * Also: renaming a speaker once for the whole note. DER and RTTM (for the
 * golden recordings) are in scripts/lib/der.mjs.
 *
 * Pure; the models run in ./diarizeModels.ts behind their seam.
 */

export interface Turn {
  start: number;
  end: number;
  speaker: string;
}

/** pyannote segmentation-3.0's 7 powerset classes → the local speakers active in each. */
export const POWERSET: ReadonlyArray<readonly number[]> = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

/** Frame logits [frames × 7] → per frame, which of the 3 local speakers speak (argmax class). */
export function powersetToSpeakers(logits: ArrayLike<number>, frames: number, classes = 7): boolean[][] {
  const out: boolean[][] = [];
  for (let f = 0; f < frames; f++) {
    let best = 0;
    for (let c = 1; c < classes; c++) if (logits[f * classes + c] > logits[f * classes + best]) best = c;
    const active = [false, false, false];
    for (const s of POWERSET[best] ?? []) active[s] = true;
    out.push(active);
  }
  return out;
}

/** Window start times (s) covering `duration` with windows of `win` s every `step` s; the last ends at the end. */
export function windowStarts(duration: number, win = 10, step = 1): number[] {
  if (duration <= win) return [0];
  const out: number[] = [];
  for (let s = 0; s + win < duration; s += step) out.push(Math.round(s * 1000) / 1000);
  out.push(Math.round((duration - win) * 1000) / 1000);
  return out;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const norm = (a: ArrayLike<number>) => Math.sqrt(dot(a, a)) || 1;
export const cosineDistance = (a: ArrayLike<number>, b: ArrayLike<number>) => 1 - dot(a, b) / (norm(a) * norm(b));

/**
 * Agglomerative clustering with centroid linkage on cosine distance (as
 * pyannote 3.1), merging while the closest pair is under `threshold`.
 * `maxSpeakers` merges further when given. → a cluster index per embedding,
 * numbered by first appearance.
 */
export function clusterEmbeddings(embeddings: ReadonlyArray<ArrayLike<number>>, threshold = 0.7045, maxSpeakers?: number): number[] {
  type C = { members: number[]; centroid: number[] };
  let clusters: C[] = embeddings.map((e, i) => {
    const n = norm(e);
    return { members: [i], centroid: Array.from(e, (x) => x / n) };
  });
  for (;;) {
    if (clusters.length < 2) break;
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const d = cosineDistance(clusters[i].centroid, clusters[j].centroid);
        if (d < bd) [bd, bi, bj] = [d, i, j];
      }
    const over = maxSpeakers !== undefined && clusters.length > maxSpeakers;
    if (bd >= threshold && !over) break;
    const a = clusters[bi];
    const b = clusters[bj];
    const n = a.members.length + b.members.length;
    const centroid = a.centroid.map((x, k) => (x * a.members.length + b.centroid[k] * b.members.length) / n);
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push({ members: [...a.members, ...b.members], centroid });
  }
  const label = new Array<number>(embeddings.length).fill(-1);
  const order = [...clusters].sort((x, y) => Math.min(...x.members) - Math.min(...y.members));
  order.forEach((c, k) => c.members.forEach((m) => (label[m] = k)));
  return label;
}

export interface LocalSpeaker {
  /** Window start (s). */
  window: number;
  /** Active frames (frame index within the window). */
  frames: number[];
}

/**
 * Frames of every window → the meeting's turns. Each (window, local speaker)
 * has a global speaker from the clustering; a frame of the timeline goes to
 * the speaker active there in most windows; runs become turns, gaps shorter
 * than `minGap` are bridged and turns shorter than `minDur` dropped.
 */
export function framesToTurns(locals: readonly LocalSpeaker[], speakerOf: readonly number[], opts: { frameSec: number; duration: number; minGap?: number; minDur?: number; name?: (k: number) => string }): Turn[] {
  const fs = opts.frameSec;
  const n = Math.ceil(opts.duration / fs);
  const votes = new Map<number, Map<number, number>>();
  locals.forEach((l, i) => {
    for (const f of l.frames) {
      const g = Math.round((l.window + f * fs) / fs);
      if (g < 0 || g >= n) continue;
      const m = votes.get(g) ?? new Map<number, number>();
      m.set(speakerOf[i], (m.get(speakerOf[i]) ?? 0) + 1);
      votes.set(g, m);
    }
  });
  const timeline: number[] = new Array(n).fill(-1);
  for (const [g, m] of votes) timeline[g] = [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const name = opts.name ?? ((k: number) => `S${k + 1}`);
  const turns: Turn[] = [];
  for (let g = 0; g < n; g++) {
    const k = timeline[g];
    if (k < 0) continue;
    const last = turns[turns.length - 1];
    const t0 = g * fs;
    if (last && last.speaker === name(k) && t0 - last.end <= (opts.minGap ?? 0.5) + 1e-9) last.end = t0 + fs;
    else turns.push({ start: t0, end: t0 + fs, speaker: name(k) });
  }
  return turns.filter((tr) => tr.end - tr.start >= (opts.minDur ?? 0.25)).map((tr) => ({ ...tr, start: round3(tr.start), end: round3(Math.min(tr.end, opts.duration)) }));
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The speaker of each transcript segment: most overlap, else the nearest turn. */
export function assignSpeakers<T extends { start: number; end: number }>(segments: readonly T[], turns: readonly Turn[]): Array<T & { speaker: string | null }> {
  return segments.map((s) => {
    const by = new Map<string, number>();
    for (const tr of turns) {
      const o = Math.min(s.end, tr.end) - Math.max(s.start, tr.start);
      if (o > 0) by.set(tr.speaker, (by.get(tr.speaker) ?? 0) + o);
    }
    let speaker: string | null = [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!speaker && turns.length) {
      const mid = (s.start + s.end) / 2;
      speaker = [...turns].sort((a, b) => Math.abs((a.start + a.end) / 2 - mid) - Math.abs((b.start + b.end) / 2 - mid))[0].speaker;
    }
    return { ...s, speaker };
  });
}

/* ─── Speakers in the note ────────────────────────────────────────── */

/** `**Name:**` speaker labels in a meeting note. */
export function speakersIn(md: string): string[] {
  return [...new Set([...md.matchAll(/^\*\*([^*\n]+?):\*\*/gm)].map((m) => m[1]))];
}

/** Rename a speaker everywhere in the note: its labels, its turns block and the speakers line. Names are plain text. */
export function renameSpeaker(md: string, from: string, to: string): string {
  const clean = to.replace(/[*\n:]/g, "").trim();
  if (!clean || clean === from) return md;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return md
    .replace(new RegExp(`^\\*\\*${esc}:\\*\\*`, "gm"), `**${clean}:**`)
    .replace(new RegExp(`("speaker":\\s*)${JSON.stringify(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), `$1${JSON.stringify(clean)}`);
}
