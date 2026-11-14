/**
 * Note cards on the canvas (plan W1.16). A note of the vault placed on the
 * canvas — `![[note]]` — is an Excalidraw *embeddable* element whose link is
 * `lumen-note:<vault path>`: Excalidraw keeps it as an ordinary element (it
 * moves, resizes, groups, binds arrows, goes into frames), and the canvas
 * renders it through `renderEmbeddable` as a live card that shows the note,
 * edits it in place and opens it in a tab (src/canvas/NoteCard.tsx).
 *
 * In the `.excalidraw` file a card is just that element, so the file still
 * opens in excalidraw.com (as an embed it can't show). In JSON Canvas (4.17)
 * a card is a `file` node — the way Obsidian Canvas and Heptabase hold notes.
 * For image export a card becomes a rounded rectangle with the note's title
 * and first lines, so PNG / SVG / PDF show what the canvas shows.
 *
 * Pure: no DOM, no Excalidraw import.
 */

import type { ExBase, ExEmbeddableElement, ExcalidrawElement, ExShapeElement, ExTextElement } from "./tldrawToExcalidraw";

export type { ExEmbeddableElement };

export const NOTE_LINK = "lumen-note:";

/** Default size of a new card (px), and the gap between cards placed together. */
export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 220;
export const CARD_GAP = 40;

/** A card's link for a vault path. The path is kept readable; only what would end the link is escaped. */
export function noteLink(path: string): string {
  return NOTE_LINK + path.replace(/%/g, "%25").replace(/\s/g, (c) => encodeURIComponent(c));
}

/** The vault path of a note card, or null when the element is not one. */
export function notePathOf(el: { type: string; link?: string | null; isDeleted?: boolean }): string | null {
  if (el.type !== "embeddable" || typeof el.link !== "string" || !el.link.startsWith(NOTE_LINK)) return null;
  try {
    const path = decodeURIComponent(el.link.slice(NOTE_LINK.length));
    return isVaultNotePath(path) ? path : null;
  } catch {
    return null;
  }
}

export const isNoteCard = (el: { type: string; link?: string | null }): boolean => notePathOf(el) !== null;

/** A relative path inside the vault to a Markdown note: no `..`, no leading `/`, no scheme. */
export function isVaultNotePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  if (path.split("/").some((p) => p === ".." || p === "." || p === "")) return false;
  return /\.(md|markdown)$/i.test(path);
}

/**
 * `![[Note]]`, `[[Folder/Note|alias]]`, `Note#Heading` or a path → the vault
 * note it names (the Obsidian rule: a full path wins, else the one file with
 * that name, preferring the shortest path), or null.
 */
export function resolveNoteRef(ref: string, notes: readonly string[]): string | null {
  const m = /^!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(ref.trim());
  let target = (m ? m[1] : ref.trim().replace(/#.*$/, "")).trim().replace(/^\.\//, "");
  if (!target) return null;
  if (!/\.(md|markdown)$/i.test(target)) target += ".md";
  const lower = target.toLowerCase();
  const exact = notes.find((n) => n.toLowerCase() === lower);
  if (exact) return exact;
  const name = lower.split("/").pop()!;
  const byName = notes.filter((n) => n.toLowerCase().split("/").pop() === name).sort((a, b) => a.length - b.length || a.localeCompare(b));
  return byName[0] ?? null;
}

/** The note's title: the frontmatter `title`, else the first heading, else the file name. */
export function noteTitle(path: string, md: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const t = fm && /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]);
  if (t) return t[1].trim();
  const h = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(stripFrontmatter(md));
  if (h) return h[1].trim();
  return (path.split("/").pop() ?? path).replace(/\.(md|markdown)$/i, "");
}

export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** The first lines of the note's text, as plain text (no Markdown marks), for the card and its export. */
export function noteExcerpt(md: string, maxLines = 6, maxChars = 280): string {
  const lines: string[] = [];
  let inCode = false;
  let first = true;
  for (const raw of stripFrontmatter(md).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    // The heading that became the title isn't repeated.
    if (first && /^#{1,6}\s/.test(raw)) {
      first = false;
      continue;
    }
    const line = plainLine(raw);
    if (!line) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    first = false;
    lines.push(line);
    if (lines.filter(Boolean).length >= maxLines) break;
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const out = lines.join("\n");
  return out.length > maxChars ? out.slice(0, maxChars - 1).trimEnd() + "…" : out;
}

function plainLine(s: string): string {
  return s
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "☐ ")
    .replace(/^\s*[-*+]\s+/, "• ")
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|==|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=$|[^\w*])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** `![[note]]` references in pasted text, when that is all the text is (one per line). */
export function pastedNoteRefs(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines.every((l) => /^!\[\[[^\]]+\]\]$/.test(l))) return null;
  return lines;
}

/** Where `n` new cards go: a row (wrapping every 4) starting at the given point. */
export function cardPositions(n: number, at: { x: number; y: number }): Array<{ x: number; y: number }> {
  return Array.from({ length: n }, (_, i) => ({ x: at.x + (i % 4) * (CARD_WIDTH + CARD_GAP), y: at.y + Math.floor(i / 4) * (CARD_HEIGHT + CARD_GAP) }));
}

/* \u2500\u2500\u2500 Export: cards as drawn shapes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

export interface CardContent {
  title: string;
  excerpt: string;
}

const PAD = 14;
const TITLE_SIZE = 20;
const BODY_SIZE = 16;
const LINE = 1.25;
/** Excalidraw's "Nunito" (normal) — a clean face for cards; Hebrew comes from the canvas fallback. */
const CARD_FONT = 6;

/** Rough text width for wrapping when there is no canvas to measure with (≈ 0.55 em per character). */
const approxWidth = (s: string, size: number) => s.length * size * 0.55;

/** Hard-wrap `text` to `width` px at `size`, by words (long words are cut). */
export function wrapLines(text: string, width: number, size: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (approxWidth(next, size) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
      while (approxWidth(line, size) > width && line.length > 1) {
        const fit = Math.max(1, Math.floor(width / (size * 0.55)));
        out.push(line.slice(0, fit));
        line = line.slice(fit);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * The scene for image export: every note card replaced by a rectangle with
 * its title and excerpt (text elements inside its bounds, RTL-aligned for a
 * Hebrew note). Arrows bound to a card keep their binding (to the
 * rectangle, which keeps the card's id). Other elements are untouched.
 */
export function cardsForExport(elements: readonly ExcalidrawElement[], content: (path: string) => CardContent | null): ExcalidrawElement[] {
  const out: ExcalidrawElement[] = [];
  for (const el of elements) {
    const path = notePathOf(el);
    if (path === null) {
      out.push(el);
      continue;
    }
    const c = content(path) ?? { title: (path.split("/").pop() ?? path).replace(/\.(md|markdown)$/i, ""), excerpt: "" };
    const rect: ExShapeElement = { ...(el as ExBase), type: "rectangle", link: null, roundness: { type: 3 }, backgroundColor: el.backgroundColor === "transparent" ? "#ffffff" : el.backgroundColor, fillStyle: "solid" };
    out.push(rect);
    // The card reads in the note's direction (its title's first strong character).
    const rtl = isRtlText(c.title.trim() ? c.title : c.excerpt);
    const align = rtl ? "right" : "left";
    const inner = Math.max(20, el.width - 2 * PAD);
    const titleLines = wrapLines(c.title, inner, TITLE_SIZE).slice(0, 2);
    const titleH = titleLines.length * TITLE_SIZE * LINE;
    const room = Math.max(0, Math.floor((el.height - 2 * PAD - titleH - 8) / (BODY_SIZE * LINE)));
    const bodyLines = room > 0 ? wrapLines(c.excerpt, inner, BODY_SIZE) : [];
    const shown = bodyLines.length > room ? [...bodyLines.slice(0, Math.max(0, room - 1)), (bodyLines[room - 1] ?? "").replace(/\s*\S*$/, "") + " …"] : bodyLines;
    const text = (id: string, s: string, y: number, size: number, h: number): ExTextElement => ({
      ...(el as ExBase),
      id,
      type: "text",
      x: el.x + PAD,
      y,
      width: inner,
      height: h,
      backgroundColor: "transparent",
      boundElements: null,
      link: null,
      roundness: null,
      text: s,
      originalText: s,
      fontSize: size,
      fontFamily: CARD_FONT,
      textAlign: align,
      verticalAlign: "top",
      containerId: null,
      autoResize: false,
      lineHeight: LINE,
      customData: undefined,
    });
    out.push(text(`${el.id}~title`, titleLines.join("\n"), el.y + PAD, TITLE_SIZE, titleH));
    if (shown.length) out.push(text(`${el.id}~body`, shown.join("\n"), el.y + PAD + titleH + 8, BODY_SIZE, shown.length * BODY_SIZE * LINE));
  }
  return out;
}

/** Does the text start (first strong character) right-to-left? Excalidraw's own test, for one line. */
export function isRtlText(s: string): boolean {
  return /^[^A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02B8\u0300-\u0590\u0800-\u1FFF\u2C00-\uFB1C\uFDFE-\uFE6F\uFEFD-\uFFFF]*[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(s);
}
