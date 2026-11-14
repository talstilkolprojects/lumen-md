/**
 * Arrow keys keep their visual meaning in right-to-left layouts (plan 9.9).
 *
 * ArrowRight moves to what is drawn on the right. In a left-to-right row
 * that is the next item; in a right-to-left row (Hebrew interface) it is
 * the previous one. Obsidian, VS Code and the ARIA practices for tabs and
 * toolbars behave this way.
 */

export type InlineDirection = "ltr" | "rtl";

/**
 * +1 for the next item in reading order, -1 for the previous one, 0 for a
 * key that isn't a horizontal arrow.
 */
export function arrowStep(key: string, dir: InlineDirection): 1 | -1 | 0 {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return 0;
  const towardsEnd = key === (dir === "rtl" ? "ArrowLeft" : "ArrowRight");
  return towardsEnd ? 1 : -1;
}

/** The computed inline direction of an element (the document's when none). */
export function inlineDirectionOf(el: Element | null | undefined): InlineDirection {
  const target = el ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!target || typeof getComputedStyle === "undefined") return "ltr";
  return getComputedStyle(target).direction === "rtl" ? "rtl" : "ltr";
}

/** Index after a roving-focus key (arrows by direction, Home, End), or null. */
export function rovingIndex(key: string, dir: InlineDirection, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = arrowStep(key, dir);
  if (!step) return null;
  return (index + step + count) % count;
}
