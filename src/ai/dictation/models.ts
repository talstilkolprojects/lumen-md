/**
 * The files live dictation downloads (plan 6.1) — pinned revisions, sizes
 * shown to the user before the download, sha256 checked after it.
 * Registered in models/registry.json (licence gate 0.10) and credited in
 * Settings → About → Credits.
 */

export interface ModelFile {
  /** Where it is fetched from. Same-origin paths are relative to the app's base URL. */
  url: string;
  bytes: number;
  /** Hex sha256 of the file, checked after the download (null = same-origin build artefact). */
  sha256: string | null;
}

export const ZIPFORMER_REPO = "ivrit-ai/zipformer2-66m-streaming-he";
export const ZIPFORMER_REVISION = "ee769a2a13b887f91572eec349458bfb0fe79e7a";
const hf = (path: string) => `https://huggingface.co/${ZIPFORMER_REPO}/resolve/${ZIPFORMER_REVISION}/${path}`;

export const ZIPFORMER_FILES = {
  encoder: { url: hf("sherpa-onnx/encoder.int8.onnx"), bytes: 70_478_964, sha256: "6c6febcb74a09435315a1d872a6539f6e7fc2c333533f14c74edc0e85c49ffcd" },
  decoder: { url: hf("sherpa-onnx/decoder.int8.onnx"), bytes: 1_049_105, sha256: "feb03e7c8aa761593a9284a6fa1e91259be3702de75f630062256c1a59c5a906" },
  joiner: { url: hf("sherpa-onnx/joiner.int8.onnx"), bytes: 771_805, sha256: "1d2c6d8e6dabc5eb52de52e95718e9bdfbffbfe7ead3808fb5ffd74e83bd9cae" },
  tokens: { url: hf("sherpa-onnx/tokens.txt"), bytes: 17_086, sha256: null }, // not an LFS file: no published sha256; the pinned revision fixes it
} satisfies Record<string, ModelFile>;

/** Silero VAD v5 (MIT), staged into public/vad/ by scripts/copy-vad.mjs from @ricky0123/vad-web. */
export const VAD_FILE: ModelFile = { url: "vad/silero_vad_v5.onnx", bytes: 2_327_524, sha256: null };

export const DICTATION_CACHE = `lumen-dictation-${ZIPFORMER_REVISION.slice(0, 8)}`;

export const dictationDownloadBytes = (): number => Object.values(ZIPFORMER_FILES).reduce((s, f) => s + f.bytes, 0) + VAD_FILE.bytes;

/** "74 MB" — what the download dialog shows. */
export const formatMB = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;

export const ATTRIBUTION = {
  zipformer:
    "Hebrew speech recognition: ivrit.ai Zipformer2 streaming model (ivrit-ai/zipformer2-66m-streaming-he), © ivrit.ai, CC BY 4.0 — https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he. Based on k2-fsa/icefall (Apache-2.0).",
  vad: "Voice activity detection: Silero VAD v5 © Silero Team, MIT; packaged by @ricky0123/vad-web (ISC).",
};
