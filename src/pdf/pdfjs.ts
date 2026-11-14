/**
 * pdf.js for the PDF reader (plan 4.14), loaded on first use: the module
 * (~150 KB gzipped, the same chunk the PDF importer uses) and its worker are
 * fetched only when a PDF is opened, never on the startup path. The worker is
 * served from this origin — no CDN.
 *
 * Only the parts of the API the reader uses are typed here, structurally, so
 * the app's types don't follow pdf.js internals.
 */

export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
}

export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  dir?: string;
}

export interface PdfTextContent {
  items: PdfTextItem[];
}

export interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  getTextContent(): Promise<PdfTextContent>;
  render(o: { canvas: HTMLCanvasElement; viewport: PdfViewport; transform?: number[] }): PdfRenderTask;
  cleanup(): boolean | void;
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

export interface PdfTextLayer {
  render(): Promise<unknown>;
  cancel(): void;
}

export interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
  TextLayer: new (o: { textContentSource: PdfTextContent; container: HTMLElement; viewport: PdfViewport }) => PdfTextLayer;
}

let loading: Promise<PdfjsModule> | null = null;

/** The pdf.js module, with its worker configured. */
export function loadPdfjs(): Promise<PdfjsModule> {
  return (loading ??= (async () => {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
    const url = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
    if (typeof url === "string" && url) pdfjs.GlobalWorkerOptions.workerSrc = url;
    return pdfjs;
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  }));
}

/** Open a PDF from its bytes. `close` frees the document and its worker. */
export async function openPdf(data: Uint8Array): Promise<{ doc: PdfDocument; close: () => Promise<void> }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  try {
    return { doc: await task.promise, close: () => task.destroy() };
  } catch (e) {
    void task.destroy();
    throw e;
  }
}
