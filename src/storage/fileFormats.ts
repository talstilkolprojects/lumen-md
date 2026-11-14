/**
 * File format converters — zero external dependencies.
 *
 * Text/markup: Markdown, HTML, RTF, XML, CSV/TSV/JSON, LaTeX, RST, AsciiDoc,
 * Org, OPML, MHTML/EML. Office/ebook (ZIP-of-XML): DOCX, ODT, EPUB — unzipped
 * via the native DecompressionStream-based reader in ./zip (no JSZip/mammoth).
 * Apple iWork (.pages/.numbers/.key) via ./iwork. Legacy .doc and image-only
 * PDF remain best-effort. All convert to Markdown.
 *
 * Uses browser-native DOMParser for XML/HTML parsing.
 */
import { iworkToMarkdown } from "./iwork";
import { readText } from "./textCodec";
import { htmlToMarkdown, rtfToMarkdown, csvToMarkdown, tsvToMarkdown, jsonToMarkdown, xmlToMarkdown, mhtmlToMarkdown, opmlToMarkdown, latexToMarkdown, rstToMarkdown, adocToMarkdown, orgToMarkdown, ipynbToMarkdown, wxrToMarkdown, confluenceToMarkdown } from "./markupFormats";
import { docxToMarkdown, odtToMarkdown, pptxToMarkdown, xlsxToMarkdown, archiveToMarkdown, epubToMarkdown } from "./officeFormats";
import { fountainToMarkdown } from "./fountain";
export { fountainToMarkdown } from "./fountain";
export { docxToMarkdown, odtToMarkdown, pptxToMarkdown, xlsxToMarkdown, archiveToMarkdown, epubToMarkdown } from "./officeFormats";
export { htmlToMarkdown, rtfToMarkdown, csvToMarkdown, tsvToMarkdown, jsonToMarkdown, xmlToMarkdown, mhtmlToMarkdown, opmlToMarkdown, latexToMarkdown, rstToMarkdown, adocToMarkdown, orgToMarkdown, ipynbToMarkdown, wxrToMarkdown, confluenceToMarkdown } from "./markupFormats";

/* ─── Unified file importer ─── */

export async function fileToMarkdown(file: File): Promise<{ name: string; content: string }> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const baseName = file.name.replace(/\.[^.]+$/, "");

  switch (ext) {
    case "rtf": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: rtfToMarkdown(text) };
    }
    case "html":
    case "htm": {
      const text = await file.text();
      // Confluence exports are XHTML wrapped in ac:/ri: macros — detect + route.
      const isConfluence = /xmlns:ac=|<ac:structured-macro|<ac:rich-text-body/i.test(text);
      return {
        name: `${baseName}.md`,
        content: isConfluence ? confluenceToMarkdown(text) : htmlToMarkdown(text),
      };
    }
    case "csv": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: csvToMarkdown(text) };
    }
    case "tsv": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: tsvToMarkdown(text) };
    }
    case "json": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: jsonToMarkdown(text) };
    }
    case "xml": {
      const text = await file.text();
      // WordPress eXtended RSS exports are .xml; route them to the WXR reader.
      const isWxr = /<wp:|xmlns:wp=/i.test(text);
      return {
        name: `${baseName}.md`,
        content: isWxr ? wxrToMarkdown(text) : xmlToMarkdown(text),
      };
    }
    case "doc": {
      return { name: `${baseName}.md`, content: await legacyDocToMarkdown(file) };
    }
    case "docx": {
      return { name: `${baseName}.md`, content: await docxToMarkdown(file) };
    }
    case "odt": {
      return { name: `${baseName}.md`, content: await odtToMarkdown(file) };
    }
    case "pptx": {
      return { name: `${baseName}.md`, content: await pptxToMarkdown(file) };
    }
    case "xlsx": {
      return { name: `${baseName}.md`, content: await xlsxToMarkdown(file) };
    }
    case "zip": {
      // Notion export / Obsidian vault — a zip of Markdown (+ CSV).
      return { name: `${baseName}.md`, content: await archiveToMarkdown(file) };
    }
    case "mhtml":
    case "mht":
    case "eml": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: mhtmlToMarkdown(text) };
    }
    case "pdf": {
      const content = await pdfToMarkdown(file);
      return { name: `${baseName}.md`, content };
    }
    case "epub": {
      const content = await epubToMarkdown(file);
      return { name: `${baseName}.md`, content };
    }
    case "opml": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: opmlToMarkdown(text) };
    }
    case "tex":
    case "ltx": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: latexToMarkdown(text) };
    }
    case "rst": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: rstToMarkdown(text) };
    }
    case "adoc":
    case "asciidoc": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: adocToMarkdown(text) };
    }
    case "org": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: orgToMarkdown(text) };
    }
    case "ipynb": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: ipynbToMarkdown(text) };
    }
    case "pages":
    case "numbers":
    case "key": {
      // Apple iWork — ZIP of XML ('09) or snappy-framed protobuf (IWA, '13+).
      const content = await iworkToMarkdown(await file.arrayBuffer(), ext, {
        pdfFallback: (pdf) =>
          pdfToMarkdown({
            name: "Preview.pdf",
            arrayBuffer: async () => pdf.slice().buffer,
          } as unknown as File),
      });
      return { name: `${baseName}.md`, content };
    }
    case "fountain":
    case "spmd": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: fountainToMarkdown(text) };
    }
    case "yaml":
    case "yml":
    case "toml":
    case "text":
    case "markdown":
    case "mdown":
    case "mkd":
    case "md":
    case "txt":
      return { name: file.name, content: await readText(file) };
    default:
      return { name: file.name, content: await file.text() };
  }
}

/** Most scanned pages one PDF import reads with OCR. */
const PDF_OCR_MAX_PAGES = 30;

/**
 * Join a PDF's per-page text (one entry per page, "" for a page without a
 * text layer). Blank pages are read with `ocrPage` (1-based page number)
 * when given — each blank page, not only when the whole PDF is blank.
 * @internal exported for tests.
 */
export async function mergePdfPageTexts(texts: string[], ocrPage: ((n: number) => Promise<string>) | null): Promise<string> {
  const pages = [...texts];
  let ocred = 0;
  let tried = 0;
  let skipped = 0;
  if (ocrPage) {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i]) continue;
      if (tried >= PDF_OCR_MAX_PAGES) {
        skipped++;
        continue;
      }
      tried++;
      const text = (await ocrPage(i + 1).catch(() => "")).trim();
      if (text) {
        pages[i] = text;
        ocred++;
      }
    }
  }
  const found = pages.filter(Boolean);
  if (!found.length) return "> ⚠️ This PDF has no extractable text (likely a scanned image), and on-device OCR found none either.";
  if (!ocred) return found.join("\n\n---\n\n");
  const head = texts.some(Boolean)
    ? "> ℹ️ Some pages are scanned — their text was recognised on this device (OCR); check it against the original."
    : "> ℹ️ Scanned PDF — text recognised on this device (OCR); check it against the original.";
  const note = skipped ? `\n\n> ℹ️ OCR read the first ${PDF_OCR_MAX_PAGES} of ${tried + skipped} scanned pages.` : "";
  return `${head}\n\n${found.join("\n\n---\n\n")}${note}`;
}

/* ─── PDF → Markdown (lazy-loads pdfjs-dist) ──────────────────────── */

/**
 * Extract a PDF's text into Markdown. Dynamic-imports `pdfjs-dist` (heavy) so
 * the cost is paid only when the user drops a PDF. Uses the locally bundled
 * worker — no CDN — and degrades honestly: scanned/image-only PDFs return a
 * clear "no extractable text" notice instead of silent garbage.
 */
export async function pdfToMarkdown(file: File): Promise<string> {
  type PdfjsModule = {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
          getViewport: (o: { scale: number }) => { width: number; height: number };
          render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
        }>;
      }>;
    };
  };
  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
    // Bundle the worker locally (no CDN). In the browser Vite emits the asset;
    // under node/vitest there is no Web Worker, so pdf.js falls back to a
    // main-thread "fake worker" and text extraction still works.
    // Worker source — no CDN. In the browser, Vite's `?url` emits the local
    // worker asset. Under node/vitest we hand pdf.js the bare module specifier
    // so it imports the worker via node_modules on the main thread (the `?url`
    // value there is a web path pdf.js can't import).
    const isNode =
      typeof process !== "undefined" && !!(process as { versions?: { node?: string } })?.versions?.node;
    let workerSrc = "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
    if (!isNode) {
      try {
        const url = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
        if (typeof url === "string" && url) workerSrc = url;
      } catch {
        /* why: keep the bare specifier, which Node and the tests resolve */
      }
    }
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const texts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      texts.push(
        content.items
          .map((it) => it.str ?? "")
          .join(" ")
          .replace(/[ \t]{2,}/g, " ")
          .trim(),
      );
    }
    // Scanned pages (no text layer): render each and read it with on-device
    // OCR (Hebrew + English, T31) — also in a mixed PDF whose cover or page
    // numbers do have text. Browser only — tests have no canvas.
    let ocrPage: ((n: number) => Promise<string>) | null = null;
    if (!isNode && typeof document !== "undefined" && texts.some((t) => !t)) {
      const { ocrImage } = await import("../ai/ocr");
      ocrPage = async (n) => {
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return "";
        await page.render({ canvasContext: ctx, viewport }).promise;
        return (await ocrImage(canvas).catch(() => ({ text: "" }))).text;
      };
    }
    return await mergePdfPageTexts(texts, ocrPage);
  } catch (err) {
    return "> ⚠️ Couldn't read this PDF: " + (err as Error).message;
  }
}

/* ─── Legacy .doc (binary Word) → Markdown ─────────────────────────── */

const DOC_LETTER = /[A-Za-zÀ-ɏ֐-׿؀-ۿ]/g;

function countLetters(s: string): number {
  return (s.match(DOC_LETTER) || []).length;
}

/** Keep only lines that are mostly letters — rejects interleaved binary noise. */
function filterReadableLines(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (t.length < 4) return false;
      return countLetters(t) / t.length >= 0.5;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Recover single-byte (ANSI/Latin-1) printable runs. */
function recoverAnsiText(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    s +=
      (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d
        ? String.fromCharCode(b)
        : "\n";
  }
  return filterReadableLines(s);
}

/** Recover UTF-16LE printable runs (modern Word stores text as UTF-16). */
function recoverUtf16Text(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    s +=
      hi === 0 &&
      ((lo >= 0x20 && lo <= 0x7e) || lo === 0x09 || lo === 0x0a || lo === 0x0d)
        ? String.fromCharCode(lo)
        : "\n";
  }
  return filterReadableLines(s);
}

/**
 * Convert a legacy binary .doc to Markdown. The old OLE/CFB Word format cannot
 * be parsed losslessly in the browser, so this is deliberately honest rather
 * than fake: it (1) reroutes files that are really RTF/HTML mislabeled as .doc,
 * (2) attempts a conservative dual-encoding text recovery (ANSI + UTF-16LE,
 * keeping whichever yields more letters), and (3) falls back to a clear
 * "couldn't extract" notice instead of dumping binary noise.
 */
export async function legacyDocToMarkdown(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder("latin1").decode(buf.subarray(0, 16));

  // A surprising share of ".doc" files in the wild are really RTF or HTML.
  if (head.startsWith("{\\rtf")) return rtfToMarkdown(new TextDecoder("latin1").decode(buf));
  if (/^\s*<(!doctype|html|\?xml)/i.test(head)) return htmlToMarkdown(new TextDecoder().decode(buf));

  const note =
    "> ⚠️ **Legacy .doc**: the old binary Word format can't be converted losslessly in the browser. " +
    "For full fidelity, open it in Word/LibreOffice and **Save As .docx** (or .rtf), then import that.\n\n---\n\n";

  const ansi = recoverAnsiText(buf);
  const utf16 = recoverUtf16Text(buf);
  const best = countLetters(utf16) > countLetters(ansi) ? utf16 : ansi;

  if (countLetters(best) < 40) {
    return note + "_No readable text could be recovered from this legacy .doc file._";
  }
  return note + best;
}

// The list lives in a module of its own, so the file picker can name the
// formats without loading the converters (startup budget).
export { SUPPORTED_IMPORT_EXTENSIONS, isSupportedFormat } from "./importExtensions";
