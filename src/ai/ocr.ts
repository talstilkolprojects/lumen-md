/**
 * On-device OCR (T31): Hebrew + English text from images and scanned PDF
 * pages, with tesseract.js (LSTM engine, tessdata_fast models).
 *
 * Everything runs in a Web Worker on this machine, and everything it loads
 * comes from this origin: the worker and its WebAssembly cores
 * (public/tesseract/, staged by scripts/copy-tesseract.mjs) and the
 * language models (public/tesseract/lang/<lang>.traineddata.gz, committed:
 * tesseract-ocr/tessdata_fast, Apache-2.0, heb ≈ 0.5 MB and eng ≈ 2 MB
 * gzipped; plan 7.5). tesseract.js keeps them in IndexedDB after the first
 * use. No image ever leaves the device, and OCR makes no outside request.
 */

import type { PlacedLine } from "./ocrLayout";
import type { Box, OcrLine } from "./ocrMixed";

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0–100. */
  confidence: number;
  /** The text's language, identified on this device (plan 6.5): BCP-47 primary tag, "und" when unclear. */
  lang?: string;
  /**
   * The lines in reading order with their logical text and box, in the
   * image's pixels (plan W1.18): the text layer of a scanned page
   * (./ocrLayout textLayerSpans). Absent when tesseract returned no lines.
   */
  lines?: PlacedLine[];
}

/** The language of recognised text; "und" when there is too little to tell. */
async function ocrLanguage(text: string): Promise<string> {
  try {
    const { detectLanguage } = await import("../text/langId");
    const g = detectLanguage(text);
    return g.confident || g.script === "hebrew" ? g.lang : "und";
  } catch {
    return "und";
  }
}

const LANGS = ["heb", "eng"] as const;
const IDLE_MS = 60_000;

type Image = Blob | HTMLCanvasElement | OffscreenCanvas | ImageData | Uint8Array;
type TesseractWorker = {
  recognize(
    image: Image,
    options?: { rectangle?: { left: number; top: number; width: number; height: number } },
    output?: { text?: boolean; blocks?: boolean },
  ): Promise<{ data: { text: string; confidence: number; blocks?: Array<{ paragraphs: Array<{ lines: Array<OcrLine & { bbox?: Box }> }> }> | null } }>;
  setParameters?(p: Record<string, unknown>): Promise<unknown>;
  terminate(): Promise<unknown>;
};

let workerPromise: Promise<TesseractWorker> | null = null;
/** Hebrew only, one word at a time: re-reads the Hebrew bits of mixed lines (./ocrMixed). Started only when a line needs it. */
let hebPromise: Promise<TesseractWorker> | null = null;
/** Latin only, one word at a time: re-reads an unsure word after a Hebrew prefix ("ה-PDF"). Started only when a line needs it. */
let latinPromise: Promise<TesseractWorker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function base(): string {
  const b = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  return new URL(`${b.replace(/\/?$/, "/")}tesseract/`, location.href).href;
}

/**
 * Where the worker fetches `<lang>.traineddata.gz`: same origin, so the
 * worker's CSP (public/_headers /tesseract/*) needs no outside host.
 * @internal exported for tests.
 */
export function langPath(): string {
  return `${base()}lang`;
}

async function getWorker(): Promise<TesseractWorker> {
  return (workerPromise ??= (async () => {
    const T = await import("tesseract.js");
    // workerBlobURL: false — a same-origin worker URL, so the worker gets its
    // own CSP (public/_headers /tesseract/*) instead of a blob: that inherits
    // the app's Trusted Types requirement.
    const w = await T.createWorker([...LANGS], T.OEM.LSTM_ONLY, {
      workerPath: `${base()}worker.min.js`,
      corePath: base(),
      langPath: langPath(),
      gzip: true,
      workerBlobURL: false,
    });
    return w as unknown as TesseractWorker;
  })().catch((e) => {
    workerPromise = null;
    throw e;
  }));
}

function singleWordWorker(lang: "heb" | "eng"): Promise<TesseractWorker> {
  return (async () => {
    const T = await import("tesseract.js");
    const w = (await T.createWorker([lang], T.OEM.LSTM_ONLY, {
      workerPath: `${base()}worker.min.js`,
      corePath: base(),
      langPath: langPath(),
      gzip: true,
      workerBlobURL: false,
    })) as unknown as TesseractWorker;
    await w.setParameters?.({ tessedit_pageseg_mode: T.PSM.SINGLE_WORD });
    return w;
  })();
}

function getHebWorker(): Promise<TesseractWorker> {
  return (hebPromise ??= singleWordWorker("heb").catch((e) => {
    hebPromise = null;
    throw e;
  }));
}

function getLatinWorker(): Promise<TesseractWorker> {
  return (latinPromise ??= singleWordWorker("eng").catch((e) => {
    latinPromise = null;
    throw e;
  }));
}

function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    for (const p of [workerPromise, hebPromise, latinPromise]) void p?.then((w) => w.terminate()).catch(() => undefined);
    workerPromise = null;
    hebPromise = null;
    latinPromise = null;
  }, IDLE_MS);
}

const rect = (b: Box) => ({ left: b.x0, top: b.y0, width: Math.max(1, b.x1 - b.x0), height: Math.max(1, b.y1 - b.y0) });

type WorkerRef = TesseractWorker | (() => Promise<TesseractWorker>) | null;

/**
 * Recognise, then fix the lines that mix Latin into Hebrew (./ocrMixed):
 * the single-word workers are asked only for those lines. `heb` and `latin`
 * may be getters so that they start only when a line needs them. Exported
 * for the node CER harness (scripts/ocr/cer-node.mjs), which runs the same
 * path.
 */
export async function recognizeWithMixedFix(main: TesseractWorker, heb: WorkerRef, image: Image, latin: WorkerRef = null): Promise<OcrResult> {
  const { data } = await main.recognize(image, {}, { text: true, blocks: true });
  type Line = OcrLine & { bbox?: Box };
  const linesOf = (blocks: typeof data.blocks): Line[] => (blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const found = linesOf(data.blocks);
  if (!found.length) return { text: data.text, confidence: data.confidence };
  const [{ fixMixedLine, needsFix }, L] = await Promise.all([import("./ocrMixed"), import("./ocrLayout")]);
  const hebrewPage = L.isRtlPage(found.map((l) => l.text));
  // Lines tesseract ran across a column gutter are cut there (./ocrLayout).
  const minGutter = L.defaultGutter(found);
  const lines: Line[] = L.splitAtGutters(found, minGutter, hebrewPage).filter((l) => L.lineBox(l));
  const fix = !!heb && lines.some((l) => needsFix(l, { hebrewPage }));
  let texts = lines.map((l) => l.text.replace(/\n$/, ""));
  if (heb && fix) {
    const reader = (w: Exclude<WorkerRef, null>) => {
      const get = typeof w === "function" ? w : async () => w;
      return async (box: Box) => {
        const r = await (await get()).recognize(image, { rectangle: rect(box) });
        return { text: r.data.text, confidence: r.data.confidence };
      };
    };
    const readers = { heb: reader(heb), latin: latin ? reader(latin) : undefined };
    texts = [];
    for (const l of lines) texts.push(needsFix(l, { hebrewPage }) ? await fixMixedLine(l, readers, { hebrewPage }) : l.text.replace(/\n$/, ""));
  }
  // Reading order from the boxes (./ocrLayout): columns right to left on a Hebrew page.
  const opts = { rtl: hebrewPage, minGutter };
  const placed = L.layoutLines(lines, texts, opts);
  if (lines.length !== found.length || L.columnCount(placed) > 1) return { text: L.layoutText(placed), confidence: data.confidence, lines: placed };
  return { text: fix ? texts.join("\n") : data.text, confidence: data.confidence, lines: placed };
}

/** Recognise text. Jobs run one at a time; the worker shuts down when idle. */
export function ocrImage(image: Blob | HTMLCanvasElement | OffscreenCanvas): Promise<OcrResult> {
  const job = queue.then(async () => {
    const w = await getWorker();
    try {
      const r = await recognizeWithMixedFix(w, getHebWorker, image as Blob, getLatinWorker);
      const text = cleanOcrText(r.text);
      return { ...r, text, lang: await ocrLanguage(text) };
    } finally {
      scheduleIdle();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

/** Collapse OCR noise: trailing spaces, runs of blank lines, lone symbols. */
export function cleanOcrText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && /[\p{L}\p{N}]{2,}/u.test(l))
    .join("\n")
    .trim();
}

/** Is this enough real text to call the image "an image with text"? */
export function meaningfulText(r: OcrResult): boolean {
  const letters = (r.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return letters >= 12 && r.confidence >= 55;
}
