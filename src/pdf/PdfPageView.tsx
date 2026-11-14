/**
 * One page of the PDF reader (split out of PdfReader.tsx, plan W4.11): the
 * canvas, the text layer and the highlight rectangles drawn on it. Loaded only
 * with PdfReader, which registers its strings.
 */
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { anchorAnnotation, findAll, shortId, type PageRect, type PdfAnnotation } from "./annotations";
import { layerText, offsetsToRange, rangePageRects } from "./textMap";
import { loadPdfjs, type PdfDocument, type PdfRenderTask, type PdfTextLayer } from "./pdfjs";
import { explainError } from "../lib/userError";
import type { OcrPage } from "./ocrPages";
import { OcrTextLayer } from "./OcrTextLayer";

export interface PageSize {
  w: number;
  h: number;
}

interface PageProps {
  doc: PdfDocument;
  page: number;
  size: PageSize;
  scale: number;
  /** Near the viewport: render it. */
  active: boolean;
  annotations: PdfAnnotation[];
  flash: { id: string; seq: number } | null;
  /** What OCR read on this page (W6.47: with line boxes, laid over the image). */
  ocr: OcrPage | undefined;
  /** Search query whose `occurrence`-th match on this page is the current hit ("" for none). */
  query: string;
  occurrence: number;
  registerEl: (page: number, el: HTMLDivElement | null) => void;
  onText: (page: number, text: string) => void;
  onOcr: (page: number, value: OcrPage) => void;
  onAnchored: (missing: string[], all: string[]) => void;
}

interface DrawnRect {
  id: string;
  kind: "highlight" | "search";
  rects: PageRect[];
  /** Rects in px of the OCR text block, not points of the page. */
  ocr?: boolean;
}

export const PdfPageView = memo(function PdfPageView({
  doc,
  page,
  size,
  scale,
  active,
  annotations,
  flash,
  ocr,
  query,
  occurrence,
  registerEl,
  onText,
  onOcr,
  onAnchored,
}: PageProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const ocrRef = useRef<HTMLDivElement>(null);
  const ocrLayerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(0);
  const [scanned, setScanned] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [drawn, setDrawn] = useState<DrawnRect[]>([]);

  // Render the canvas and the text layer while the page is near the viewport.
  useEffect(() => {
    const host = canvasHost.current;
    const layer = textRef.current;
    if (!active || !host || !layer) return;
    let cancelled = false;
    let task: PdfRenderTask | null = null;
    let textLayer: PdfTextLayer | null = null;
    (async () => {
      const [pdfjs, p] = await Promise.all([loadPdfjs(), doc.getPage(page)]);
      if (cancelled) return;
      const viewport = p.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.setAttribute("aria-hidden", "true");
      task = p.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      // Cancelled when the page scrolls away: not an error.
      task.promise.catch(() => undefined);
      const content = await p.getTextContent();
      if (cancelled) return;
      layer.replaceChildren();
      textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
      await Promise.all([task.promise, textLayer.render()]);
      if (cancelled) return;
      host.replaceChildren(canvas);
      const text = layerText(layer);
      setScanned(!text.trim());
      onText(page, text);
      setReady((n) => n + 1);
    })().catch(() => {
      /* why: cancelled (scrolled away / zoomed) or a broken page: the box stays empty */
    });
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
      host.replaceChildren();
      layer.replaceChildren();
      setDrawn([]);
    };
  }, [active, doc, page, scale, onText]);

  // Where this page's highlights (and the current search hit) are.
  useEffect(() => {
    const box = boxRef.current;
    if (!active || !box || !ready) return;
    // `loose`: text that OCR read, searched loosely (findAll).
    const layers: { el: HTMLElement; ocr: boolean; loose: boolean }[] = [];
    if (textRef.current && layerText(textRef.current).trim()) layers.push({ el: textRef.current, ocr: false, loose: false });
    // W6.47: the OCR layer over the page is in page coordinates, like the page's own text.
    if (ocrLayerRef.current) layers.push({ el: ocrLayerRef.current, ocr: false, loose: true });
    if (ocrRef.current) layers.push({ el: ocrRef.current, ocr: true, loose: true });
    const out: DrawnRect[] = [];
    const missing: string[] = [];
    for (const a of annotations) {
      const id = shortId(a.id);
      let placed = false;
      for (const { el, ocr } of layers) {
        const anchor = anchorAnnotation(a, layerText(el));
        const range = anchor && offsetsToRange(el, anchor.start, anchor.end);
        if (!range) continue;
        const origin = (ocr ? el : box).getBoundingClientRect();
        out.push({ id, kind: "highlight", rects: rangePageRects(range, origin, ocr ? 1 : scale), ocr });
        placed = true;
        break;
      }
      if (!placed) missing.push(id);
    }
    if (query && occurrence >= 0) {
      for (const { el, ocr, loose } of layers) {
        const hit = findAll(layerText(el), query, { loose })[occurrence];
        const range = hit && offsetsToRange(el, hit.start, hit.end);
        if (!range) continue;
        const origin = (ocr ? el : box).getBoundingClientRect();
        out.push({ id: "search", kind: "search", rects: rangePageRects(range, origin, ocr ? 1 : scale), ocr });
        range.startContainer.parentElement?.scrollIntoView({ block: "center" });
        break;
      }
    }
    setDrawn(out);
    onAnchored(
      missing,
      annotations.map((a) => shortId(a.id)),
    );
  }, [active, ready, annotations, scale, query, occurrence, ocr, onAnchored]);

  // Bring a flashed highlight into view.
  useEffect(() => {
    if (!flash) return;
    const el = boxRef.current?.parentElement?.querySelector(`[data-highlight-id="${flash.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [flash, drawn]);

  const runOcr = useCallback(async () => {
    setOcrBusy(true);
    try {
      const { ocrPdfPage } = await import("./ocrPages");
      onOcr(page, await ocrPdfPage(doc, page));
      setReady((n) => n + 1);
    } catch (e) {
      showAiToast(t("pdf.failed", { error: explainError(e) }), "error");
    } finally {
      setOcrBusy(false);
    }
  }, [doc, page, onOcr]);

  const style = {
    width: `${size.w * scale}px`,
    height: `${size.h * scale}px`,
    "--total-scale-factor": String(scale),
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  } as CSSProperties;

  const pct = (r: PageRect): CSSProperties => ({
    left: `${(r.left / size.w) * 100}%`,
    top: `${(r.top / size.h) * 100}%`,
    width: `${(r.width / size.w) * 100}%`,
    height: `${(r.height / size.h) * 100}%`,
  });
  const px = (r: PageRect): CSSProperties => ({ left: r.left, top: r.top, width: r.width, height: r.height });

  const marks = (ocr: boolean) =>
    drawn
      .filter((d) => !!d.ocr === ocr)
      .map((d) => (
        <div
          key={`${d.kind}-${d.id}`}
          className={`pdf-hl-group pdf-hl--${d.kind}`}
          data-highlight-id={d.kind === "highlight" ? d.id : undefined}
          data-search-hit={d.kind === "search" ? "true" : undefined}
          data-flash={d.kind === "highlight" && flash?.id === d.id ? "true" : undefined}
        >
          {d.rects.map((r, i) => (
            // Re-keyed per flash, so the same highlight flashes again on the next open.
            <span key={`${i}-${flash?.id === d.id ? flash.seq : 0}`} className="pdf-hl-rect" style={ocr ? px(r) : pct(r)} />
          ))}
        </div>
      ));

  return (
    <div className="pdf-page-wrap" data-page-wrap={page}>
      <div
        ref={(el) => {
          boxRef.current = el;
          registerEl(page, el);
        }}
        className="pdf-page"
        data-page-number={page}
        data-rendered={ready > 0 && active ? "true" : undefined}
        style={style}
        dir="ltr"
        role="region"
        aria-label={t("pdf.page.label", { n: page })}
      >
        <div ref={canvasHost} className="pdf-canvas" />
        <div className="pdf-hl-layer">{marks(false)}</div>
        <div ref={textRef} className="textLayer" data-pdf-text="page" />
        {ocr?.spans && (
          // W6.47: the recognised lines where they are on the image — transparent, selectable, in reading order.
          <OcrTextLayer ref={ocrLayerRef} spans={ocr.spans} pageHeightPx={size.h * scale} />
        )}
        {active && scanned && ocr === undefined && (
          <div className="pdf-scanned">
            <p>{t("pdf.ocr.scanned")}</p>
            <button type="button" className="pdf-primary" disabled={ocrBusy} onClick={() => void runOcr()}>
              {ocrBusy ? t("pdf.ocr.running") : t("pdf.ocr.run")}
            </button>
          </div>
        )}
      </div>
      {ocr !== undefined && !ocr.spans && (
        // OCR without line boxes: the text under the page, as before W6.47.
        <div className="pdf-ocr-wrap" style={{ width: `${size.w * scale}px` }}>
          <div className="pdf-hl-layer">{marks(true)}</div>
          <div ref={ocrRef} className="pdf-ocr" data-pdf-text="ocr" dir="auto">
            {ocr.text || t("pdf.ocr.scanned")}
          </div>
        </div>
      )}
    </div>
  );
});
