/**
 * One focus trap for every dialog (plan 10.1). While a dialog is open:
 *  - focus moves into it (an `[autofocus]` / `[data-autofocus]` element, else
 *    the first focusable one, else the dialog itself);
 *  - Tab and Shift+Tab cycle inside it, and focus that lands outside (a click
 *    on the page behind, a script) is brought back;
 *  - Escape calls `onEscape`;
 *  - when it closes, focus returns to where it was before it opened.
 * Dialogs stack (a prompt over a settings panel): only the top one traps and
 * handles Escape. Focus the dialog moves itself (a search box on open) is
 * kept.
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "summary",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** The elements Tab can reach inside `root`, in order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.closest("[hidden],[inert]")) return false;
    if (el.tabIndex < 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export interface FocusTrapOptions {
  /** Trap only while true (default true) — for dialogs that stay mounted while closed. */
  active?: boolean;
  /** Escape pressed while this is the top dialog. */
  onEscape?: () => void;
  /** Return focus to the element that had it before (default true). */
  restoreFocus?: boolean;
}

const stack: HTMLElement[] = [];
const isTop = (el: HTMLElement) => stack[stack.length - 1] === el;

/**
 * The last element focused outside every modal dialog. A dialog whose own
 * effect focuses a field before its trap starts (the settings screen's
 * search box) has that field as `document.activeElement` when the trap
 * looks; focus then returns here instead, to what opened the dialog.
 */
let lastOutside: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && !t.closest('[aria-modal="true"]')) lastOutside = t;
    },
    true,
  );
}

export function useFocusTrap<T extends HTMLElement>(ref: RefObject<T | null>, options: FocusTrapOptions = {}): void {
  const { active = true, restoreFocus = true } = options;
  const onEscape = useRef(options.onEscape);
  onEscape.current = options.onEscape;

  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    let before = document.activeElement as HTMLElement | null;
    if (before && root.contains(before)) before = lastOutside;
    stack.push(root);

    const enter = () => {
      if (root.contains(document.activeElement)) return; // the dialog focused something itself
      const auto = root.querySelector<HTMLElement>("[autofocus],[data-autofocus]");
      const target = auto ?? focusableIn(root)[0];
      if (target) target.focus();
      else {
        if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
        root.focus();
      }
    };
    // After the dialog's own effects (which may focus an input) have run.
    const timer = setTimeout(enter, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop(root)) return;
      // Bubble phase: a widget inside the dialog that handles Escape itself
      // (and calls preventDefault) keeps it.
      if (e.key === "Escape" && onEscape.current && !e.defaultPrevented) {
        e.preventDefault();
        onEscape.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (!current || !root.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (current === first || current === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!isTop(root)) return;
      const target = e.target as Node | null;
      if (target && !root.contains(target) && document.contains(root)) enter();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const i = stack.lastIndexOf(root);
      if (i >= 0) stack.splice(i, 1);
      if (restoreFocus && before && before !== document.body && document.contains(before)) {
        // After React has removed the dialog.
        setTimeout(() => {
          if (!stack.length || !stack[stack.length - 1].contains(document.activeElement)) before.focus();
        }, 0);
      }
    };
  }, [ref, active, restoreFocus]);
}
