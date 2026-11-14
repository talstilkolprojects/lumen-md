/**
 * Speech-recognition adapters (plan W11.H6, W11.H18): FLEURS (he_il, yi_us),
 * ivrit.ai eval-d1 and eval-whatsapp, VoxKnesset.
 *
 * Formats read:
 * - "fleurs-tsv": google/fleurs `<config>/<split>.tsv` as published — tab-separated,
 *   no header: id, file name, raw transcription, transcription, words
 *   (space-separated letters), number of samples, gender. Audio is
 *   `<config>/audio/<split>/<file name>` once the split's tar.gz is unpacked
 *   (`fetch` unpacks it).
 *   The reference is the raw transcription; both sides go through the same
 *   normaliser (the "transcription" column is FLEURS' own lower-cased
 *   normalisation, which no leaderboard uses for Hebrew).
 * - "audio-jsonl": what scripts/eval-public/export_hf_audio.py writes from a
 *   Hugging Face audio dataset (ivrit-ai/eval-d1, ivrit-ai/eval-whatsapp, VoxKnesset):
 *   one JSON object per line, { "id", "audio" (path relative to the data
 *   folder), "text" }. The Hub stores these sets as Parquet with embedded
 *   audio, which needs pyarrow to read; the export runs where the data is
 *   downloaded (owed, Mac).
 */
import { countChars, countWords, microRate, r4, type ErrorCounts } from "../metrics";

export interface AsrItem {
  id: string;
  /** Audio file, relative to the dataset's data folder. */
  audio: string;
  text: string;
}

/** An ASR engine under test: Zipformer in the browser, whisper.cpp on the desktop, the phone's… */
export interface AsrEngine {
  id: string;
  transcribe(audio: string): Promise<string>;
}

/** `base`: the folder of the .tsv inside the data folder ("data/he_il"), where `audio/<split>/` is unpacked. */
export function parseFleursTsv(text: string, split: string, base = ""): AsrItem[] {
  const pre = base ? `${base.replace(/\/+$/, "")}/` : "";
  const out: AsrItem[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 7) throw new Error(`fleurs-tsv line ${i + 1}: expected 7 tab-separated columns, got ${cols.length}`);
    const [id, file, raw] = cols;
    if (!/^\d+$/.test(id) || !file) throw new Error(`fleurs-tsv line ${i + 1}: bad id or file name`);
    // One sentence id is read by several speakers: the file name keeps the items apart.
    out.push({ id: `${id}/${file}`, audio: `${pre}audio/${split}/${file}`, text: raw });
  }
  return out;
}

export function parseAudioJsonl(text: string): AsrItem[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      let o: { id?: unknown; audio?: unknown; text?: unknown };
      try {
        o = JSON.parse(l);
      } catch {
        throw new Error(`audio-jsonl line ${i + 1}: not JSON`);
      }
      if (typeof o.id !== "string" && typeof o.id !== "number") throw new Error(`audio-jsonl line ${i + 1}: id is required`);
      if (typeof o.audio !== "string" || typeof o.text !== "string") throw new Error(`audio-jsonl line ${i + 1}: audio and text must be strings`);
      return { id: String(o.id), audio: o.audio, text: o.text };
    });
}

export interface AsrScore {
  n: number;
  metrics: { wer: number; cer: number };
  /** Items whose transcription failed (counted as empty hypotheses, so they cost their full length). */
  failed: string[];
  items: { id: string; ref: string; hyp: string; wordEdits: number; refWords: number }[];
}

export async function scoreAsr(items: readonly AsrItem[], engine: AsrEngine, norm: (s: string) => string): Promise<AsrScore> {
  const w: ErrorCounts[] = [];
  const c: ErrorCounts[] = [];
  const failed: string[] = [];
  const rows: AsrScore["items"] = [];
  for (const it of items) {
    let hyp = "";
    try {
      hyp = await engine.transcribe(it.audio);
    } catch {
      failed.push(it.id);
    }
    const p = { ref: norm(it.text), hyp: norm(hyp) };
    const wc = countWords(p);
    w.push(wc);
    c.push(countChars(p));
    rows.push({ id: it.id, ref: p.ref, hyp: p.hyp, wordEdits: wc.edits, refWords: wc.refTokens });
  }
  return { n: items.length, metrics: { wer: r4(microRate(w)), cer: r4(microRate(c)) }, failed, items: rows };
}
