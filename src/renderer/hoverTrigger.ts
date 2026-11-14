/**
 * The always-loaded part of the hover preview (plan 4.6): event handlers
 * for the preview pane. Pointing at a `[[link]]` for 80 ms, or focusing it
 * with the keyboard, loads ./hoverPreview (on first use) and shows the
 * card; leaving, blur or Escape hides it.
 */

import type { FocusEvent, KeyboardEvent, MouseEvent } from "react";

type Mod = typeof import("./hoverPreview");
let loaded: Promise<Mod> | null = null;
const load = () => (loaded ??= import("./hoverPreview"));
let timer: ReturnType<typeof setTimeout> | null = null;

/** Pointing at a link this long first: passing over it shows nothing. */
export const HOVER_DELAY = 80;

const linkOf = (t: EventTarget | null) => {
  const a = (t as Element | null)?.closest?.("a.wiki-link[data-wiki-target]") ?? null;
  // Same-note anchors (`[[#Heading]]`) are right here: nothing to preview.
  return a && !(a.getAttribute("data-wiki-target") ?? "").trim().startsWith("#") ? a : null;
};

function show(a: Element, delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void load().then((m) => m.hoverCard().show(a, a.getAttribute("data-wiki-target") ?? "")), delay);
}

function hide(delay: number) {
  if (timer) clearTimeout(timer);
  if (!loaded) return;
  timer = setTimeout(
    () =>
      void loaded!.then((m) => {
        const card = m.hoverCard();
        // The pointer moved onto the card: keep it (it is read there).
        if (!card.el.matches(":hover")) card.hide();
      }),
    delay,
  );
}

export const wikiHoverHandlers = {
  onMouseOver(e: MouseEvent) {
    const a = linkOf(e.target);
    if (a && !a.contains(e.relatedTarget as Node | null)) show(a, HOVER_DELAY);
  },
  onMouseOut(e: MouseEvent) {
    const a = linkOf(e.target);
    if (a && !a.contains(e.relatedTarget as Node | null)) hide(150);
  },
  onFocus(e: FocusEvent) {
    const a = linkOf(e.target);
    if (a) show(a, 0);
  },
  onBlur(e: FocusEvent) {
    if (linkOf(e.target)) hide(0);
  },
  onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") hide(0);
  },
};
