/** Whisper tiny (transformers.js) on the Hebrew speech set: the transcript of each recording. */
import { decodeAudioTo16k, transcribeAudio, transformersDevice, WHISPER_MODELS } from "../../ai/transformersEngine";
import { dataUrlBlob, type BenchEngine } from "../types";

const MODEL = WHISPER_MODELS.tiny;

export const engine: BenchEngine = {
  id: "whisper-tiny",
  label: "Whisper tiny",
  set: "asr-he",
  models: [MODEL],
  async load() {
    // One second of silence: loads (and on a cold cache downloads) the model.
    await transcribeAudio(new Float32Array(16_000), { language: "he", model: MODEL });
    return { device: await transformersDevice(), model: MODEL };
  },
  async run(item) {
    const pcm = await decodeAudioTo16k(await dataUrlBlob((item.input as { audio: string }).audio));
    return (await transcribeAudio(pcm, { language: "he", model: MODEL })).text;
  },
};
