/**
 * Drag to resize an image in the preview (W1.3, Obsidian 1.12). Dragging the
 * image's inline-end edge (the right edge in English, the left in Hebrew)
 * changes its width, and on release the width is written to the note:
 * `![[img.png]]` becomes `![[img.png|300]]` and `![alt](img.png)` becomes
 * `![alt|300](img.png)`.
 *
 * Images carry their source offset (`data-md-offset`, from remarkObsidian).
 * The offset is checked against the text before it is used; if the note
 * changed since the render, the nearest image with the same target is
 * edited instead, and nothing at all if there is none.
 */
import { t } from "../i18n";

const SIZE = /^\d{1,5}(?:x\d{1,5})?$/;

function rewriteEmbed(src: string, width: number): string | null {
  const m = /^!\[\[([^\]\n|]+?)((?:\|[^\]\n]*)*)\]\]/.exec(src);
  if (!m) return null;
  const params = m[2].split("|").slice(1).filter((p) => !SIZE.test(p.trim()));
  return `![[${m[1]}${params.map((p) => `|${p}`).join("")}|${width}]]`;
}

function rewriteMarkdownImage(src: string, width: number): string | null {
  const m = /^!\[([^\]\n]*)\]\(/.exec(src);
  if (!m) return null;
  const alt = m[1].replace(/\|\d{1,5}(?:x\d{1,5})?$/, "");
  return `![${alt}|${width}](`;
}

/** The note with the image at `offset` set to `width`; the note unchanged if no image is there. */
export function setImageWidth(md: string, offset: number, width: number, target?: string): string {
  const w = Math.max(16, Math.min(99999, Math.round(width)));
  const at = (i: number) => {
    const rest = md.slice(i);
    const embed = /^!\[\[([^\]\n]+)\]\]/.exec(rest);
    const next = embed ? rewriteEmbed(rest, w) : rewriteMarkdownImage(rest, w);
    if (next === null) return null;
    const len = embed ? embed[0].length : (/^!\[[^\]\n]*\]\(/.exec(rest)?.[0].length ?? 0);
    return md.slice(0, i) + next + md.slice(i + len);
  };
  if (offset >= 0 && offset < md.length && md.startsWith("![", offset)) {
    const r = at(offset);
    if (r !== null) return r;
  }
  if (!target) return md;
  // The note moved on since the render: the closest image with this target.
  let best = -1;
  for (let i = md.indexOf("![", 0); i >= 0; i = md.indexOf("![", i + 2)) {
    const head = md.slice(i, i + 400);
    if (!head.includes(target)) continue;
    if (best < 0 || Math.abs(i - offset) < Math.abs(best - offset)) best = i;
  }
  return best >= 0 ? (at(best) ?? md) : md;
}

const EDGE = 12;

/** Wire the drag on a preview root. `onResize` gets the offset, the image's target and the new width. */
export function attachImageResize(
  root: HTMLElement,
  onResize: (offset: number, target: string, width: number) => void,
): () => void {
  const atEdge = (img: HTMLImageElement, x: number) => {
    const r = img.getBoundingClientRect();
    const rtl = getComputedStyle(img).direction === "rtl";
    return rtl ? x - r.left <= EDGE : r.right - x <= EDGE;
  };
  const move = (e: PointerEvent) => {
    const img = (e.target as Element | null)?.closest?.("img[data-md-offset]") as HTMLImageElement | null;
    if (!img) return;
    if (atEdge(img, e.clientX)) {
      img.setAttribute("data-resize-edge", "");
      img.title = t("preview.imageResize.hint");
    } else img.removeAttribute("data-resize-edge");
  };
  const down = (e: PointerEvent) => {
    const img = (e.target as Element | null)?.closest?.("img[data-md-offset]") as HTMLImageElement | null;
    if (!img || e.button !== 0 || !atEdge(img, e.clientX)) return;
    e.preventDefault();
    const rtl = getComputedStyle(img).direction === "rtl";
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    let w = startW;
    const drag = (ev: PointerEvent) => {
      w = Math.max(16, startW + (rtl ? startX - ev.clientX : ev.clientX - startX));
      img.style.width = `${Math.round(w)}px`;
      img.style.height = "auto";
    };
    const up = () => {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", up);
      if (Math.round(w) !== Math.round(startW)) {
        onResize(Number(img.getAttribute("data-md-offset")), img.getAttribute("data-md-target") ?? "", w);
      }
    };
    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", up);
  };
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerdown", down);
  return () => {
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerdown", down);
  };
}
