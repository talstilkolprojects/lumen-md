/**
 * Footnotes with hover (W1.3): pointing at, or tabbing to, a footnote
 * reference in the preview shows the footnote's text next to it, as
 * Obsidian does, without scrolling to the bottom of the note.
 *
 * The popover is a copy of the rendered footnote (already sanitized by the
 * pipeline), minus its back link. It reads in the footnote's own direction.
 */
import { t } from "../i18n";

const REF = "a[data-footnote-ref]";

export function attachFootnoteHover(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  let pop: HTMLElement | null = null;
  let anchor: Element | null = null;

  const hide = () => {
    pop?.remove();
    pop = null;
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
  };

  const show = (a: HTMLAnchorElement) => {
    if (anchor === a) return;
    hide();
    const id = decodeURIComponent((a.getAttribute("href") ?? "").replace(/^#/, ""));
    if (!id) return;
    const note = Array.from(root.querySelectorAll("[id]")).find((n) => n.id === id);
    if (!note) return;
    const copy = note.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-footnote-backref]").forEach((n) => n.remove());
    copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    pop = doc.createElement("div");
    pop.className = "footnote-popover";
    pop.id = "footnote-popover";
    pop.setAttribute("role", "tooltip");
    pop.setAttribute("dir", "auto");
    pop.setAttribute("aria-label", t("preview.footnote.label", { n: a.textContent ?? "" }));
    pop.append(...Array.from(copy.childNodes));
    doc.body.appendChild(pop);
    const r = a.getBoundingClientRect();
    const w = pop.offsetWidth;
    const vw = doc.documentElement.clientWidth || 1024;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.left - w / 2 + r.width / 2, vw - w - 8)))}px`;
    a.setAttribute("aria-describedby", pop.id);
    anchor = a;
  };

  const over = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.(REF) as HTMLAnchorElement | null;
    if (a && root.contains(a)) show(a);
  };
  const out = (e: Event) => {
    const to = (e as MouseEvent | FocusEvent).relatedTarget as Node | null;
    if (anchor && (!to || (!anchor.contains(to) && !pop?.contains(to)))) hide();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };
  root.addEventListener("mouseover", over);
  root.addEventListener("focusin", over);
  root.addEventListener("mouseout", out);
  root.addEventListener("focusout", out);
  doc.addEventListener("keydown", key);
  return () => {
    hide();
    root.removeEventListener("mouseover", over);
    root.removeEventListener("focusin", over);
    root.removeEventListener("mouseout", out);
    root.removeEventListener("focusout", out);
    doc.removeEventListener("keydown", key);
  };
}
