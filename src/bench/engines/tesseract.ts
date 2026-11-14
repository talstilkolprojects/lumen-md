/** The app's OCR (tesseract.js, LSTM, tessdata_fast heb + eng) on the Hebrew OCR set: the text of each line or page image. */
import { ocrImage } from "../../ai/ocr";
import { dataUrlBlob, type BenchEngine } from "../types";

// A white 8×8 PNG: the first call starts the worker and loads the language models.
const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAADklEQVR4nGP4DwUMlDEA98A/wbI0QbsAAAAASUVORK5CYII=";

export const engine: BenchEngine = {
  id: "tesseract",
  label: "tesseract.js (heb + eng)",
  set: "ocr-he",
  models: ["tessdata_fast/heb.traineddata", "tessdata_fast/eng.traineddata"],
  async load() {
    await ocrImage(await dataUrlBlob(BLANK));
    return { device: "wasm" };
  },
  run: async (item) => (await ocrImage(await dataUrlBlob((item.input as { image: string }).image))).text,
};
