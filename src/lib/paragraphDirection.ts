/**
 * An explicit direction for one paragraph, saved in the note (plan W11.H4).
 *
 * The rule of plan 9.7 (first strong character) is right for most lines,
 * but not for every mixed line: "iPhone 17 יצא היום" is a Hebrew sentence
 * that starts with a Latin word. The writer can switch such a paragraph:
 * the switch writes U+200F RIGHT-TO-LEFT MARK or U+200E LEFT-TO-RIGHT MARK
 * right after the line's Markdown markers ("- ", "## ", "> ", "1. "). The
 * mark is invisible, a strong character in the Unicode sense, so the
 * direction rule of both editors (lib/bidiDirection) and every other
 * Markdown app that honours first-strong (GitHub, Obsidian, browsers with
 * dir="auto") read the paragraph the same way after the note is closed and
 * opened again. Nothing else is stored.
 *
 * The whole note: `dir: rtl | ltr | auto` in the frontmatter. `auto` is the
 * first-strong rule; an explicit paragraph mark wins over the note's pin,
 * because it is the more specific choice.
 */
import { MARKERS, markdownLineDirection, type LineDirection } from "./bidiDirection";

export const RLM = "‏";
export const LRM = "‎";
export type Dir = "auto" | "ltr" | "rtl";

/** End offset of a leading YAML frontmatter block (just past its closing fence), or -1. */
export function frontmatterEnd(doc: string): number {
  if (!doc.startsWith("---")) return -1;
  const end = doc.indexOf("\n---", 3);
  return end < 0 ? -1 : end + 4;
}

/** `dir: rtl|ltr|auto` from a note's YAML frontmatter, else null. */
export function frontmatterDir(doc: string): Dir | null {
  const end = frontmatterEnd(doc);
  if (end < 0) return null;
  const m = /^dir:\s*["']?(auto|ltr|rtl)["']?\s*$/m.exec(doc.slice(3, end - 4));
  return m ? (m[1] as Dir) : null;
}

/** Where the paragraph's text starts: after its Markdown block markers. */
export const textStart = (line: string): number => MARKERS.exec(line)?.[0].length ?? 0;

/** The direction a paragraph was switched to (its mark), or null. */
export function explicitDirection(line: string): LineDirection | null {
  const c = line[textStart(line)];
  return c === RLM ? "rtl" : c === LRM ? "ltr" : null;
}

/** The line without its switch mark. */
export function withoutSwitch(line: string): string {
  const at = textStart(line);
  return line[at] === RLM || line[at] === LRM ? line.slice(0, at) + line.slice(at + 1) : line;
}

/**
 * The direction a line is shown in: its switch, else the note's pin (rtl /
 * ltr), else its first strong character after the markers, else `fallback`
 * (the note's direction).
 */
export function resolveLineDirection(line: string, pinned: Dir | null, fallback: LineDirection): LineDirection {
  return explicitDirection(line) ?? (pinned && pinned !== "auto" ? pinned : (markdownLineDirection(line) ?? fallback));
}

/**
 * The line set to `target`. A mark is written only when the line would not
 * read that way without one, so switching twice gives back the original
 * text; "auto" removes the switch.
 */
export function setLineDirection(line: string, target: Dir, ctx: { pinned: Dir | null; fallback: LineDirection }): string {
  const bare = withoutSwitch(line);
  if (target === "auto") return bare;
  if (resolveLineDirection(bare, ctx.pinned, ctx.fallback) === target) return bare;
  const at = textStart(bare);
  return bare.slice(0, at) + (target === "rtl" ? RLM : LRM) + bare.slice(at);
}

/** The switch: the other direction from the one the line is shown in now. */
export function toggledLine(line: string, ctx: { pinned: Dir | null; fallback: LineDirection }): string {
  const now = resolveLineDirection(line, ctx.pinned, ctx.fallback);
  return setLineDirection(line, now === "rtl" ? "ltr" : "rtl", ctx);
}
