/**
 * The text of a PDF page's text layer as one string, and the way between
 * offsets in that string and DOM ranges (plan 4.14).
 *
 * pdf.js puts one `<span>` per text item in the layer and a `<br>` after an
 * item that ends a line, so the page text is every text node's data with a
 * newline per `<br>` — the same string `pageTextFromItems` builds from the
 * page's text content, which is what search and re-anchoring run on.
 */

import type { PageRect } from "./annotations";

/** Page text from pdf.js text content items (`str`, `hasEOL`). */
export function pageTextFromItems(items: readonly { str?: string; hasEOL?: boolean }[]): string {
  let out = "";
  for (const it of items) {
    if (it.str === undefined) continue; // marked-content markers carry no text
    out += it.str;
    if (it.hasEOL) out += "\n";
  }
  return out;
}

interface Piece {
  /** A text node, or null for the newline of a `<br>`. */
  node: Text | null;
  start: number;
  length: number;
}

function pieces(root: Node): { text: string; parts: Piece[] } {
  const parts: Piece[] = [];
  let text = "";
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const data = (n as Text).data;
      if (!data) continue;
      parts.push({ node: n as Text, start: text.length, length: data.length });
      text += data;
    } else if ((n as Element).tagName === "BR") {
      parts.push({ node: null, start: text.length, length: 1 });
      text += "\n";
    }
  }
  return { text, parts };
}

/** The text of a text layer (or of any element, with `<br>` as newline). */
export function layerText(container: Element): string {
  return pieces(container).text;
}

/** Text length of a DOM fragment, by the same rules. */
function fragmentLength(frag: Node): number {
  return pieces(frag).text.length;
}

/** Offset in the layer text of a DOM boundary point; points outside the layer clamp to its ends. */
export function boundaryOffset(container: Element, node: Node, offset: number): number {
  const doc = container.ownerDocument ?? document;
  if (node !== container && !container.contains(node)) {
    const all = doc.createRange();
    all.selectNodeContents(container);
    return all.comparePoint(node, offset) < 0 ? 0 : layerText(container).length;
  }
  const pre = doc.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(node, offset);
  return fragmentLength(pre.cloneContents());
}

/** `[start, end)` of `range` in the layer text, or null when the range doesn't touch the layer. */
export function rangeToOffsets(container: Element, range: Range): { start: number; end: number } | null {
  // A range wholly before (or after) the layer clamps to an empty span.
  const start = boundaryOffset(container, range.startContainer, range.startOffset);
  const end = boundaryOffset(container, range.endContainer, range.endOffset);
  if (end <= start) return null;
  return { start, end };
}

/** A DOM range over `[start, end)` of the layer text (null when the text isn't there). */
export function offsetsToRange(container: Element, start: number, end: number): Range | null {
  const { text, parts } = pieces(container);
  if (start < 0 || end > text.length || end <= start) return null;
  const doc = container.ownerDocument ?? document;
  const range = doc.createRange();
  let startSet = false;
  for (const p of parts) {
    if (!p.node) continue;
    if (!startSet && start < p.start + p.length) {
      range.setStart(p.node, Math.max(0, start - p.start));
      startSet = true;
    }
    if (startSet && end <= p.start + p.length) {
      range.setEnd(p.node, Math.max(0, end - p.start));
      return range;
    }
  }
  if (!startSet) return null;
  range.setEndAfter(container.lastChild ?? container);
  return range;
}

/**
 * The rectangles a range covers, relative to `pageBox`, in PDF points
 * (`scale` CSS pixels per point). One per line fragment of each text node,
 * so a highlight follows the text — right-to-left lines included, since the
 * browser lays out each span in its own direction.
 */
export function rangePageRects(range: Range, pageBox: { left: number; top: number }, scale: number): PageRect[] {
  const out: PageRect[] = [];
  const doc = range.startContainer.ownerDocument ?? document;
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(root.nodeType === Node.TEXT_NODE ? (root.parentNode ?? root) : root, NodeFilter.SHOW_TEXT);
  for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const t = n as Text;
    const sub = doc.createRange();
    sub.selectNodeContents(t);
    if (t === range.startContainer) sub.setStart(t, range.startOffset);
    if (t === range.endContainer) sub.setEnd(t, range.endOffset);
    // No layout (a DOM without rendering, e.g. jsdom): nothing to measure.
    if (sub.collapsed || typeof sub.getClientRects !== "function") continue;
    for (const r of Array.from(sub.getClientRects())) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      out.push({
        left: (r.left - pageBox.left) / scale,
        top: (r.top - pageBox.top) / scale,
        width: r.width / scale,
        height: r.height / scale,
      });
    }
  }
  return out;
}
