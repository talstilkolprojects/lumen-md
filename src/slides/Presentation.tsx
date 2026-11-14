/**
 * The presentation (plan W2.17): full screen, one slide at a time, right to
 * left where the slide is. Every slide is rendered once, before the show
 * starts, and stays in the DOM; changing slide only flips which one is
 * shown, so it takes well under 50 ms (the time is kept on the root as
 * `data-switch-ms` for the e2e).
 *
 * Keys follow the deck's direction (./deck slideForKey); Esc ends the show.
 * "Presenter" opens the presenter view (notes, next slide, timer) in its own
 * window; "PDF" prints every slide on its own landscape page ("Save as
 * PDF"), the text staying text in its own direction.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./strings";
import "./Presentation.css";
import { t } from "../i18n";
import { slideForKey, type Dir } from "./deck";
import { closePresenterWindow, openChannel, openPresenterWindow, type SharedSlide } from "./channel";
import { HelpButton } from "../ui/HelpButton";

export interface SlideView {
  title: string;
  notes: string;
  dir: Dir;
  content: ReactNode;
}

export interface PresentationProps {
  title: string;
  dir: Dir;
  slides: SlideView[];
  start?: number;
  onClose: () => void;
}

let deckSeq = 0;

export function Presentation({ title, dir, slides, start = 0, onClose }: PresentationProps) {
  const [index, setIndex] = useState(Math.min(start, Math.max(0, slides.length - 1)));
  const root = useRef<HTMLDivElement>(null);
  const pressedAt = useRef<number | null>(null);
  const deckId = useMemo(() => `deck-${Date.now().toString(36)}-${++deckSeq}`, []);
  const startedAt = useMemo(() => Date.now(), []);
  const channel = useRef<ReturnType<typeof openChannel>>(null);
  const indexRef = useRef(index);

  const go = useCallback(
    (i: number) => {
      pressedAt.current = performance.now();
      setIndex(Math.min(slides.length - 1, Math.max(0, i)));
    },
    [slides.length],
  );

  // How long the last change took, from the key to the new slide in the DOM.
  useLayoutEffect(() => {
    if (pressedAt.current === null || !root.current) return;
    root.current.dataset.switchMs = (performance.now() - pressedAt.current).toFixed(2);
    pressedAt.current = null;
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const next = slideForKey(e.key, index, slides.length, dir);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      go(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, slides.length, dir, go, onClose]);

  // Full screen while presenting (the browser may refuse; the overlay covers the window anyway).
  useEffect(() => {
    const el = root.current;
    void el?.requestFullscreen?.().catch(() => undefined);
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  /** The slides as the presenter view shows them. */
  const shared = useCallback((): SharedSlide[] => {
    const sections = Array.from(root.current?.querySelectorAll<HTMLElement>(".lumen-slide-content") ?? []);
    return slides.map((s, i) => ({ title: s.title, notes: s.notes, dir: s.dir, html: sections[i]?.innerHTML ?? "" }));
  }, [slides]);

  useEffect(() => {
    const ch = openChannel((m) => {
      if (m.type === "hello") ch?.post({ type: "state", deck: deckId, title, index: indexRef.current, slides: shared(), startedAt });
      else if (m.type === "go" && m.deck === deckId) go(m.index);
    });
    channel.current = ch;
    return () => {
      ch?.post({ type: "end", deck: deckId });
      ch?.close();
      void closePresenterWindow();
    };
  }, [deckId, title, shared, startedAt, go]);

  useEffect(() => {
    indexRef.current = index;
    channel.current?.post({ type: "index", deck: deckId, index });
  }, [index, deckId]);

  const printPdf = useCallback(() => {
    const html = document.documentElement;
    html.classList.add("lumen-printing-slides");
    const done = () => {
      html.classList.remove("lumen-printing-slides");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }, []);

  const cur = slides[index];
  return createPortal(
    <div
      ref={root}
      className="lumen-slides-root"
      role="dialog"
      aria-modal="true"
      aria-label={t("slides.label", { title })}
      data-testid="slides"
      data-index={index}
      data-count={slides.length}
      dir={dir}
      tabIndex={-1}
    >
      <div className="lumen-slides-stage" onClick={(e) => (e.target as HTMLElement).closest("a,button,input,textarea,select") || go(index + 1)}>
        {slides.map((s, i) => (
          <section key={i} className="lumen-slide" hidden={i !== index} aria-hidden={i !== index} dir={s.dir} data-testid="slide" data-slide={i}>
            <div className="lumen-slide-content">{s.content}</div>
          </section>
        ))}
      </div>
      <div className="lumen-slides-bar" dir={dir}>
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label={t("slides.prev")} data-testid="slides-prev">
          {dir === "rtl" ? "→" : "←"}
        </button>
        <span className="lumen-slides-count" data-testid="slides-count">
          {t("slides.count", { n: index + 1, total: slides.length })}
        </span>
        <button type="button" onClick={() => go(index + 1)} disabled={index === slides.length - 1} aria-label={t("slides.next")} data-testid="slides-next">
          {dir === "rtl" ? "←" : "→"}
        </button>
        <span className="lumen-slides-title" dir="auto">
          {cur?.title}
        </span>
        <HelpButton topic="workspace/slides#presenting" />
        <button type="button" onClick={() => void openPresenterWindow()} data-testid="slides-presenter">
          {t("slides.presenter")}
        </button>
        <button type="button" onClick={printPdf} data-testid="slides-pdf">
          {t("slides.pdf")}
        </button>
        <button type="button" onClick={onClose} data-testid="slides-close">
          {t("slides.close")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
