/**
 * Transcribe a meeting recording with who said what (plan W2.7). Lazy: the
 * palette command imports it on use.
 *
 *   audio file → W1.17 transcription (ivrit.ai Whisper, on this device)
 *              → speaker turns (./diarizeModels, behind its seam)
 *              → each sentence gets the speaker it overlaps most
 *              → the user names each speaker once (a sample sentence shown)
 *              → 6.16 meeting notes from the named transcript
 *
 * The note gets the summary, then the transcript with `**Name:**` labels and
 * a time linked to the audio on every line, and a `lumen-speaker-turns` JSON
 * block (the turns, for renaming later and for the DER evaluation in
 * scripts/meetings/der.mjs). While the diarization models aren't pinned the
 * transcript is inserted without speakers and the toast says so.
 */
import "./speakerStrings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { useAppStore } from "../store/useStore";
import { getAiPolicy } from "../ai/policy";
import { clock, sentencesOf, timeFragment, type Sentence } from "../ai/dictation/longform";
import { assignSpeakers, renameSpeaker, speakersIn, type Turn } from "./diarize";
import { DIARIZATION_MODELS, diarizationAvailable, diarize, type DiarizationModels, type ModelFile, type OrtLike } from "./diarizeModels";
import { log } from "../lib/logger";
import { explainError } from "../lib/userError";

export const TURNS_FENCE = "json lumen-speaker-turns";

export type SpokenSentence = Sentence & { speaker: string | null };

/** One line per sentence: `**S1:** [▶ 0:07](<audio#t=7,9.5>) text` (no label when the speaker is unknown). */
export function speakerTranscript(sentences: readonly SpokenSentence[], audioPath: string | null): string {
  return sentences
    .map((s) => {
      const time = clock(s.start);
      const stamp = audioPath ? `[▶ ${time}](<${audioPath}${timeFragment(s)}>)` : `\`${time}\``;
      return `${s.speaker ? `**${s.speaker}:** ` : ""}${stamp} ${s.text}`;
    })
    .join("\n");
}

/** The transcript the meeting writer reads: `Name: text` per sentence. */
export function plainTranscript(sentences: readonly SpokenSentence[]): string {
  return sentences.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n");
}

/** The turns block (rounded to ms). */
export function turnsBlock(turns: readonly Turn[]): string {
  const rows = turns.map((tr) => JSON.stringify({ start: tr.start, end: tr.end, speaker: tr.speaker }));
  return "```" + TURNS_FENCE + "\n[\n" + rows.join(",\n") + "\n]\n```";
}

/** The turns block of a note, or null. */
export function readTurns(md: string): Turn[] | null {
  const m = new RegExp("```" + TURNS_FENCE.replace(/ /g, "\\s+") + "\\n([\\s\\S]*?)\\n```").exec(md);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]) as unknown;
    if (!Array.isArray(v)) return null;
    return v.filter((x): x is Turn => !!x && typeof x.start === "number" && typeof x.end === "number" && typeof x.speaker === "string");
  } catch {
    return null;
  }
}

/** The longest sentence of each speaker (shown when asking for the name), in order of first appearance. */
export function sampleSentences(sentences: readonly SpokenSentence[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sentences) {
    if (!s.speaker) continue;
    const prev = out.get(s.speaker);
    if (prev === undefined || s.text.length > prev.length) out.set(s.speaker, s.text);
  }
  return out;
}

/** Put the linked transcript in place of the plain one inside the meeting note's details. */
export function withLinkedTranscript(markdown: string, plain: string, linked: string): string {
  const at = markdown.lastIndexOf(plain);
  return at < 0 ? markdown : markdown.slice(0, at) + linked + markdown.slice(at + plain.length);
}

/* ─── The models' runtime (browser) ────────────────────────────────── */

const CACHE = "lumen-diarization";

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A pinned model file from its revision on Hugging Face, size and sha256 checked; kept in Cache Storage. */
async function loadModel(m: ModelFile, signal?: AbortSignal): Promise<Uint8Array> {
  const url = modelUrl(m);
  let cache: Cache | null = null;
  try {
    cache = typeof caches !== "undefined" ? await caches.open(CACHE) : null;
  } catch {
    cache = null;
  }
  const hit = await cache?.match(url);
  const bytes = new Uint8Array(await (hit ?? (await fetch(url, { signal }))).arrayBuffer());
  if (bytes.length !== m.bytes) throw new Error(`size mismatch for ${m.file}: ${bytes.length} bytes, expected ${m.bytes}`);
  if ((await sha256Hex(bytes)) !== m.sha256) throw new Error(`checksum mismatch for ${m.file}`);
  if (!hit) {
    try {
      await cache?.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    } catch {
      /* quota: it still works for this session */
    }
  }
  return bytes;
}

const modelUrl = (m: ModelFile) => `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;

/** Bytes still to download (0 when both networks are in the cache). */
async function missingBytes(models: DiarizationModels): Promise<number> {
  let cache: Cache | null = null;
  try {
    cache = typeof caches !== "undefined" ? await caches.open(CACHE) : null;
  } catch {
    cache = null;
  }
  let n = 0;
  for (const m of [models.segmentation, models.embedding]) if (!(await cache?.match(modelUrl(m)))) n += m.bytes ?? 0;
  return n;
}

/** Turns, or null when the user declined the one-time download. */
async function runDiarization(samples: Float32Array, models: DiarizationModels, signal?: AbortSignal): Promise<Turn[] | null> {
  const missing = await missingBytes(models);
  if (missing > 0) {
    const { uiConfirm } = await import("../ui/PromptDialog");
    if (!(await uiConfirm({ message: t("speakers.download", { mb: Math.ceil(missing / 1_048_576) }) }))) return null;
  }
  const [ort, { OnlineFbank }, { ortBaseUrl }] = await Promise.all([
    import("onnxruntime-web/wasm"),
    import("../ai/dictation/fbank"),
    import("../ai/transformersEngine"),
  ]);
  const base = ortBaseUrl();
  ort.env.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.mjs`, wasm: `${base}ort-wasm-simd-threaded.wasm` };
  // The networks run in ORT's own worker, off the editor's thread.
  ort.env.wasm.proxy = true;
  let lastToast = 0;
  return diarize(
    samples,
    {
      ort: ort as unknown as OrtLike,
      load: (m) => loadModel(m, signal),
      fbank: (x) => {
        const fb = new OnlineFbank();
        fb.accept(x);
        fb.finish();
        return fb.frames();
      },
      onProgress: (done, total) => {
        if (performance.now() - lastToast < 5000 && done < total) return;
        lastToast = performance.now();
        showAiToast(t("speakers.diarizing", { done, total }), "info");
      },
      signal,
    },
    models,
  );
}

/* ─── The command ──────────────────────────────────────────────────── */

export async function transcribeMeeting(file?: File | null, models: DiarizationModels = DIARIZATION_MODELS): Promise<void> {
  const tf = await import("../ui/TranscribeFile");
  const picked = file ?? (await tf.pickFile());
  if (!picked) return;
  const started = performance.now();
  const [{ aiOperation, isAbort }, { uiPrompt }] = await Promise.all([import("../ai/aiAbort"), import("../ui/PromptDialog")]);
  const op = aiOperation();
  try {
    const { samples, duration, segments } = await tf.transcribeFileAudio(picked, { keepSamples: diarizationAvailable(models) });
    const sentences = sentencesOf(segments);
    if (!sentences.length) {
      showAiToast(t("transcribeFile.empty"), "info");
      return;
    }
    let turns: Turn[] = [];
    if (!diarizationAvailable(models)) showAiToast(t("speakers.unavailable"), "info");
    else {
      try {
        turns = samples ? ((await runDiarization(samples, models, op.signal)) ?? []) : [];
      } catch (e) {
        if (isAbort(e)) throw e;
        log.warn("diarization", e);
        showAiToast(t("speakers.failed", { error: explainError(e) }), "error");
      }
    }
    let spoken: SpokenSentence[] = turns.length ? assignSpeakers(sentences, turns) : sentences.map((s) => ({ ...s, speaker: null }));

    // Name each speaker once.
    for (const [speaker, sample] of sampleSentences(spoken)) {
      const name = (await uiPrompt({ message: t("speakers.namePrompt", { speaker, sample: sample.slice(0, 160) }), placeholder: t("speakers.namePlaceholder", { speaker }) }))?.replace(/[*\n:]/g, "").trim();
      if (!name || name === speaker) continue;
      spoken = spoken.map((s) => (s.speaker === speaker ? { ...s, speaker: name } : s));
      turns = turns.map((tr) => (tr.speaker === speaker ? { ...tr, speaker: name } : tr));
    }

    const audioPath = await tf.keepAudio(picked);
    const linked = speakerTranscript(spoken, audioPath);
    const plain = plainTranscript(spoken);
    let body = `### ${picked.name}\n\n${linked}`;
    try {
      const { meetingNotesFrom, offerIcs } = await import("./meetingNotes");
      const res = await meetingNotesFrom(plain, { signal: op.signal, local: getAiPolicy() === "local-only" });
      body = withLinkedTranscript(res.markdown, plain, linked);
      void offerIcs(res);
    } catch (e) {
      if (isAbort(e)) throw e;
      showAiToast(t("speakers.notesFailed", { error: explainError(e) }), "error");
    }
    if (turns.length) body += `\n\n${turnsBlock(turns)}`;
    tf.insert(`\n\n${body}\n`);
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    // RTF for the W2.7 measurement (processing time / audio time).
    log.info(`meeting transcription: ${duration.toFixed(1)} s of audio in ${seconds} s (RTF ${(seconds / Math.max(duration, 1e-3)).toFixed(3)})`);
    showAiToast(t("speakers.done", { n: spoken.length, speakers: new Set(spoken.map((s) => s.speaker).filter(Boolean)).size, seconds }), "success");
  } catch (e) {
    if (isAbort(e)) return;
    showAiToast(t("transcribeFile.failed", { error: explainError(e) }), "error");
  } finally {
    op.end();
  }
}

/** Rename one speaker everywhere in the open note (labels and the turns block). */
export async function renameSpeakerInNote(): Promise<void> {
  const { uiPrompt, uiSelect } = await import("../ui/PromptDialog");
  const st = useAppStore.getState();
  const speakers = speakersIn(st.doc.content);
  if (!speakers.length) {
    showAiToast(t("speakers.none"), "info");
    return;
  }
  const from = speakers.length === 1 ? speakers[0] : await uiSelect({ message: t("speakers.pick"), choices: speakers.map((s) => ({ value: s, label: s })) });
  if (!from) return;
  const to = (await uiPrompt({ message: t("speakers.renamePrompt", { speaker: from }), defaultValue: from }))?.trim();
  if (!to || to === from) return;
  const next = renameSpeaker(useAppStore.getState().doc.content, from, to);
  useAppStore.getState().setContent(next);
  showAiToast(t("speakers.renamed", { from, to: to.replace(/[*\n:]/g, "").trim() }), "success");
}
