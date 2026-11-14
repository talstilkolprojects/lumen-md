/**
 * The presenter view (plan W2.17): the app opened at `#lumen-presenter` in
 * its own window — on the desktop on the laptop's screen while the slides
 * fill the other one. It shows the current and next slide, the speaker
 * notes and a timer, and moves the show (← → keys or the buttons). It holds
 * nothing of its own: the slides come over the BroadcastChannel.
 */

import { useEffect, useRef, useState } from "react";
import "./strings";
import "./Presentation.css";
import { t } from "../i18n";
import { safeSetHtml } from "../lib/trustedTypes";
import { slideForKey } from "./deck";
import { openChannel, type SlidesMessage, type SharedSlide } from "./channel";

function SlideHtml({ slide }: { slide: SharedSlide | undefined }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) safeSetHtml(el.current, slide?.html ?? "");
  }, [slide]);
  return (
    <section className="lumen-slide" dir={slide?.dir ?? "auto"}>
      <div className="lumen-slide-content" ref={el} />
    </section>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function PresenterView() {
  const [state, setState] = useState<Extract<SlidesMessage, { type: "state" }> | null>(null);
  const [now, setNow] = useState(Date.now());
  const ch = useRef<ReturnType<typeof openChannel>>(null);

  useEffect(() => {
    const c = openChannel((m) => {
      if (m.type === "state") setState(m);
      else if (m.type === "index") setState((s) => (s && s.deck === m.deck ? { ...s, index: m.index } : s));
      else if (m.type === "end") setState((s) => (s && s.deck === m.deck ? null : s));
    });
    ch.current = c;
    c?.post({ type: "hello" });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    document.title = t("slides.presenterTitle");
    return () => {
      clearInterval(timer);
      c?.close();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state) return;
      const dir = state.slides[0]?.dir ?? "ltr";
      const next = slideForKey(e.key, state.index, state.slides.length, dir);
      if (next === null) return;
      e.preventDefault();
      ch.current?.post({ type: "go", deck: state.deck, index: next });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  if (!state)
    return (
      <div className="lumen-presenter" data-testid="presenter-waiting">
        <p>{t("slides.presenterWaiting")}</p>
      </div>
    );
  const cur = state.slides[state.index];
  const nxt = state.slides[state.index + 1];
  const go = (i: number) => ch.current?.post({ type: "go", deck: state.deck, index: i });
  return (
    <div className="lumen-presenter" dir={cur?.dir ?? "ltr"} data-testid="presenter" data-index={state.index}>
      <div className="lumen-presenter-head">
        <span className="lumen-presenter-timer" data-testid="presenter-timer">
          {clock(now - state.startedAt)}
        </span>
        <span dir="auto">{state.title}</span>
        <span>{t("slides.count", { n: state.index + 1, total: state.slides.length })}</span>
        <span className="lumen-presenter-controls">
          <button type="button" onClick={() => go(state.index - 1)} disabled={state.index === 0}>
            {t("slides.prev")}
          </button>
          <button type="button" onClick={() => go(state.index + 1)} disabled={state.index >= state.slides.length - 1}>
            {t("slides.next")}
          </button>
        </span>
      </div>
      <div className="lumen-presenter-current">
        <SlideHtml slide={cur} />
      </div>
      <div className="lumen-presenter-next">
        <div>{nxt ? t("slides.nextUp", { title: nxt.title || String(state.index + 2) }) : t("slides.last")}</div>
        {nxt && <SlideHtml slide={nxt} />}
      </div>
      <div className="lumen-presenter-notes" dir="auto" data-testid="presenter-notes">
        {/* empty-allow: the speaker-notes field of the current slide, shown while presenting */}
        {cur?.notes || t("slides.noNotes")}
      </div>
    </div>
  );
}
