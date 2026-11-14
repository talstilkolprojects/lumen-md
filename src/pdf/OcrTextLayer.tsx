/**
 * W6.47 — the text OCR read on a scanned page, laid over the page image:
 * one transparent span per recognised line, placed and sized from the
 * line's box (fractions of the page), in reading order, so selecting,
 * searching and highlighting work on the page itself. Each line ends with a
 * newline, so the layer's text (`layerText`) is exactly `OcrPage.text`.
 *
 * Its own file so the scanned-page test renders exactly what the reader
 * does. The styles that place the spans are inline: the layer is right even
 * where PdfReader.css is not loaded.
 */
import { forwardRef, type CSSProperties } from "react";
import type { TextLayerSpan } from "../ai/ocrLayout";

const LAYER: CSSProperties = { position: "absolute", inset: 0, zIndex: 2, overflow: "clip", lineHeight: 1 };
const SPAN: CSSProperties = {
  position: "absolute",
  color: "transparent",
  whiteSpace: "pre",
  overflow: "hidden",
  cursor: "text",
  textAlign: "justify",
  textAlignLast: "justify",
  userSelect: "text",
};

export const OcrTextLayer = forwardRef<HTMLDivElement, { spans: readonly TextLayerSpan[]; pageHeightPx: number }>(function OcrTextLayer({ spans, pageHeightPx }, ref) {
  return (
    <div ref={ref} className="pdf-ocr-layer" data-pdf-text="ocr-layer" data-testid="pdf-ocr-layer" style={LAYER}>
      {spans.map((sp, i) => (
        <span
          key={i}
          dir={sp.dir}
          style={{
            ...SPAN,
            left: `${sp.left * 100}%`,
            top: `${sp.top * 100}%`,
            width: `${sp.width * 100}%`,
            height: `${sp.height * 100}%`,
            fontSize: `${Math.max(4, sp.height * pageHeightPx * 0.85)}px`,
          }}
        >
          {`${sp.text}\n`}
        </span>
      ))}
    </div>
  );
});
