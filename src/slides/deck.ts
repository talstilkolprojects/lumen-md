/**
 * Slides from notes and from the canvas (plan W2.17), the pure part.
 *
 * A note → a deck: a `---` line ends a slide and an H1 / H2 heading starts
 * one (both, in the same note); code fences never split. Each slide keeps
 * its Markdown (rendered by the app's own renderer), its title (its first
 * heading), its speaker notes and its direction. Speaker notes are the
 * lines after `Note:` / `Notes:` / `הערות:` (Reveal's convention) or inside
 * `<!-- notes … -->`; they never show on the slide.
 *
 * A canvas → a deck: every Excalidraw frame is a slide. Arrows between
 * frames give the order (an arrow from frame A to frame B: B comes after
 * A); frames no arrow reaches start a chain, taken in reading order (top
 * to bottom, then right to left on a Hebrew canvas, left to right
 * otherwise). A text element in a frame that starts with `Note:` /
 * `הערות:` is that slide's speaker notes and is left out of the picture.
 *
 * Pure: no DOM.
 */

import { createFenceTracker } from "../storage/exportFormats";
import { firstStrongDirection, markdownBaseDirection } from "../lib/textDirection";

export type Dir = "ltr" | "rtl";

export interface NoteSlide {
  index: number;
  title: string;
  /** The slide's Markdown, notes removed. */
  markdown: string;
  notes: string;
  dir: Dir;
}

export interface Deck {
  title: string;
  dir: Dir;
  slides: NoteSlide[];
}

const NOTES_START = /^\s*(?:notes?|הערות|הערה)\s*:\s?(.*)$/i;
const NOTES_COMMENT = /<!--\s*notes?\b:?\s*([\s\S]*?)-->/gi;

function frontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*["']?(.*?)["']?\s*$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return { fm, body: md.slice(m[0].length) };
}

/** Split a note's body into slide chunks: `---` ends a slide, H1 / H2 starts one; fence-aware. */
export function splitNoteSlides(body: string): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const s = cur.join("\n").trim();
    if (s) chunks.push(s);
    cur = [];
  };
  const fenceAt = createFenceTracker();
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const { fence, inCode } = fenceAt(line);
    if (!fence && !inCode) {
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        const prev = cur[cur.length - 1];
        // "Text" right above "---" is a heading (setext H2), not a break: it starts a slide, as an H2 does.
        if (/^\s{0,3}-/.test(line) && prev !== undefined && prev.trim() && !/^\s*([-*+>]|\d+[.)]|#)/.test(prev) && !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(prev)) {
          cur.pop();
          flush();
          cur.push(`## ${prev.trim()}`);
          continue;
        }
        flush();
        continue;
      }
      if (/^#{1,2}\s/.test(line)) flush();
    }
    cur.push(line);
  }
  flush();
  return chunks;
}

/** A chunk's speaker notes taken out: `Note:` to the end of the slide, and `<!-- notes … -->` anywhere. */
export function takeNotes(chunk: string): { markdown: string; notes: string } {
  const notes: string[] = [];
  let text = chunk.replace(NOTES_COMMENT, (_, n: string) => {
    notes.push(n.trim());
    return "";
  });
  const lines = text.split("\n");
  const fenceAt = createFenceTracker();
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const { fence, inCode } = fenceAt(lines[i]);
    if (!fence && !inCode && NOTES_START.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at >= 0) {
    const first = NOTES_START.exec(lines[at])![1];
    notes.push([first, ...lines.slice(at + 1)].join("\n").trim());
    text = lines.slice(0, at).join("\n");
  }
  return { markdown: text.trim(), notes: notes.filter(Boolean).join("\n\n") };
}

/** The slide's title: its first heading, as plain text. */
export function slideTitle(md: string): string {
  const h = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(md);
  return h ? h[1].replace(/[*_`~=]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim() : "";
}

/** A note as a deck. `dir` in the frontmatter wins; else each slide follows its own text, the deck its first slide. */
export function noteToDeck(md: string, fallbackTitle = "Slides"): Deck {
  const { fm, body } = frontmatter(md);
  const forced: Dir | null = fm.dir === "rtl" || fm.dir === "ltr" ? fm.dir : null;
  const slides = splitNoteSlides(body).map((chunk, index): NoteSlide => {
    const { markdown, notes } = takeNotes(chunk);
    return { index, title: slideTitle(markdown), markdown, notes, dir: forced ?? markdownBaseDirection(markdown) };
  });
  if (!slides.length) {
    const md = `# ${fm.title ?? fallbackTitle}`;
    slides.push({ index: 0, title: fm.title ?? fallbackTitle, markdown: md, notes: "", dir: forced ?? markdownBaseDirection(md) });
  }
  const deckDir: Dir = forced ?? slides[0].dir;
  return { title: fm.title ?? slides[0].title ?? fallbackTitle, dir: deckDir, slides };
}

/* ─── Navigation ───────────────────────────────────────────────────── */

/**
 * The slide a key goes to. Arrow keys follow the reading direction of the
 * deck: on a right-to-left deck ← is "next" (as in a Hebrew book) and → is
 * "previous". Space / PageDown / Enter / ↓ next, PageUp / Backspace / ↑
 * previous, Home / End the first and last. Null: not a navigation key.
 */
export function slideForKey(key: string, current: number, count: number, dir: Dir): number | null {
  const last = Math.max(0, count - 1);
  const clamp = (i: number) => Math.min(last, Math.max(0, i));
  switch (key) {
    case "ArrowRight":
      return clamp(current + (dir === "rtl" ? -1 : 1));
    case "ArrowLeft":
      return clamp(current + (dir === "rtl" ? 1 : -1));
    case " ":
    case "PageDown":
    case "ArrowDown":
    case "Enter":
    case "n":
      return clamp(current + 1);
    case "PageUp":
    case "ArrowUp":
    case "Backspace":
    case "p":
      return clamp(current - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/* ─── Canvas frames ────────────────────────────────────────────────── */

export interface CanvasElementLike {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  frameId?: string | null;
  isDeleted?: boolean;
  name?: string | null;
  text?: string;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
}

export interface FrameSlide {
  index: number;
  frameId: string;
  title: string;
  notes: string;
  /** Text elements that are speaker notes (left out of the slide's picture). */
  noteElementIds: string[];
  dir: Dir;
}

/** The frame an element is in: its frameId, or the frame its box lies in. */
function frameOf(el: CanvasElementLike, frames: readonly CanvasElementLike[]): string | null {
  if (el.frameId && frames.some((f) => f.id === el.frameId)) return el.frameId;
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const f = frames.find((fr) => cx >= fr.x && cx <= fr.x + fr.width && cy >= fr.y && cy <= fr.y + fr.height);
  return f?.id ?? null;
}

/** The canvas's frames as slides, in arrow order (then reading order). */
export function framesToDeck(elements: readonly CanvasElementLike[]): FrameSlide[] {
  const live = elements.filter((e) => !e.isDeleted);
  const frames = live.filter((e) => e.type === "frame" || e.type === "magicframe");
  if (!frames.length) return [];
  const texts = live.filter((e) => e.type === "text" && typeof e.text === "string");
  const canvasDir: Dir = firstStrongDirection([...frames.map((f) => f.name ?? ""), ...texts.map((t) => t.text ?? "")].join(" ")) ?? "ltr";

  // Arrow edges between frames (an arrow bound to an element inside a frame counts for that frame).
  const containerFrame = new Map<string, string>();
  for (const el of live) {
    if (el.type === "frame" || el.type === "magicframe") containerFrame.set(el.id, el.id);
    else {
      const f = frameOf(el, frames);
      if (f) containerFrame.set(el.id, f);
    }
  }
  const next = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const a of live) {
    if (a.type !== "arrow") continue;
    const from = a.startBinding ? containerFrame.get(a.startBinding.elementId) : undefined;
    const to = a.endBinding ? containerFrame.get(a.endBinding.elementId) : undefined;
    if (!from || !to || from === to) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }

  // Reading order: rows (frames whose tops are within half the smaller height), then across.
  const reading = [...frames].sort((a, b) => {
    const sameRow = Math.abs(a.y - b.y) < Math.min(a.height, b.height) / 2;
    if (!sameRow) return a.y - b.y;
    return canvasDir === "rtl" ? b.x + b.width - (a.x + a.width) : a.x - b.x;
  });
  const rank = new Map(reading.map((f, i) => [f.id, i]));
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    let cur: string | undefined = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      order.push(cur);
      cur = (next.get(cur) ?? []).filter((n) => !seen.has(n)).sort((a, b) => rank.get(a)! - rank.get(b)!)[0];
    }
  };
  for (const f of reading) if (!incoming.get(f.id)) walk(f.id);
  for (const f of reading) walk(f.id); // cycles

  return order.map((id, index) => {
    const frame = frames.find((f) => f.id === id)!;
    const inFrame = texts.filter((t) => frameOf(t, frames) === id);
    const noteEls = inFrame.filter((t) => NOTES_START.test((t.text ?? "").split("\n")[0]));
    const notes = noteEls.map((t) => (t.text ?? "").replace(/^\s*(?:notes?|הערות|הערה)\s*:\s?/i, "").trim()).join("\n\n");
    const shown = inFrame.filter((t) => !noteEls.includes(t)).sort((a, b) => a.y - b.y);
    const title = frame.name?.trim() || (shown[0]?.text ?? "").split("\n")[0].trim();
    const dir = firstStrongDirection([frame.name ?? "", ...shown.map((t) => t.text ?? "")].join(" ")) ?? canvasDir;
    return { index, frameId: id, title, notes, noteElementIds: noteEls.map((t) => t.id), dir };
  });
}
