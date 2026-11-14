/**
 * Daily review (plan W3.3): today's 5–10 cards — highlights and
 * question::answer lines — one at a time: show, reveal, rate Again / Hard /
 * Good / Easy (keys 1–4, space reveals). FSRS-5 schedules the next review;
 * everything is saved in `.lumen/review.json` in the vault.
 *
 * Fast to open: the queue comes from the review file alone (one read). The
 * vault's current highlights and cards are gathered afterwards, in the
 * background, and only add to tomorrow's queue.
 */
import "./strings";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { fsrs, type Rating } from "./fsrs";
import { dailyQueue, emptyReviewFile, highlightCard, parseReviewFile, qaCards, rate, REVIEW_PATH, serializeReviewFile, syncSources, type Entry, type ReviewFile } from "./cards";
import "../highlights/HighlightsPanel.css";
import "./ReviewPanel.css";
import { HelpButton } from "../ui/HelpButton";
import { explainError } from "../lib/userError";
import { EmptyState, learnHow } from "../ui/EmptyState";

const scheduler = fsrs();

function isMissing(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "NotFoundError";
}

export async function readReviewFile(): Promise<ReviewFile | null> {
  const ws = await import("../storage/workspace");
  try {
    return parseReviewFile(await ws.readWorkspaceFile(REVIEW_PATH));
  } catch (e) {
    if (isMissing(e)) return emptyReviewFile();
    throw e;
  }
}

async function writeReviewFile(f: ReviewFile): Promise<void> {
  const ws = await import("../storage/workspace");
  await ws.writeWorkspaceFile(REVIEW_PATH, serializeReviewFile(f));
}

/** Every reviewable source in the vault now. */
export async function gatherSources() {
  const [{ loadIndex }, ws] = await Promise.all([import("../highlights/HighlightsPanel"), import("../storage/workspace")]);
  const highlights = (await loadIndex()).map(highlightCard);
  const notes = (await ws.listWorkspace()).map((f) => f.path).filter((p) => /\.(md|markdown)$/i.test(p) && !/\.(pdf|epub)\.md$/i.test(p));
  const qa = (await Promise.all(notes.map(async (p) => qaCards(p, await ws.readWorkspaceFile(p).catch(() => ""))))).flat();
  return [...highlights, ...qa];
}

export function ReviewPanel({ onClose, opened = performance.now(), now = () => new Date() }: { onClose: () => void; opened?: number; now?: () => Date }) {
  const [queue, setQueue] = useState<Entry[] | null>(null);
  const [pos, setPos] = useState(0);
  const [shown, setShown] = useState(false);
  const [openMs, setOpenMs] = useState<number | null>(null);
  const file = useRef<ReviewFile | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const f = await readReviewFile();
      if (cancelled) return;
      if (!f) {
        showAiToast(t("srs.unreadable", { path: REVIEW_PATH }), "error");
        setQueue([]);
        return;
      }
      file.current = f;
      setQueue(dailyQueue(f, now()));
      // Tomorrow's cards: whatever the vault holds now (never the schedules).
      const sources = await gatherSources().catch(() => null);
      if (cancelled || !sources || !file.current) return;
      const synced = syncSources(file.current, sources, now());
      file.current = synced;
      writes.current = writes.current.then(() => writeReviewFile(synced)).catch(() => undefined);
      setQueue((q) => (q && q.length ? q : dailyQueue(synced, now())));
    })().catch((e: unknown) => showAiToast(t("srs.failed", { error: explainError(e) }), "error"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (queue && openMs === null) setOpenMs(performance.now() - opened);
    rootRef.current?.focus({ preventScroll: true });
  }, [queue]);

  const current = queue?.[pos] ?? null;
  const answer = (g: Rating) => {
    if (!current || !file.current) return;
    const next = rate(file.current, current.id, g, now(), scheduler);
    file.current = next;
    writes.current = writes.current.then(() => writeReviewFile(next)).catch((e: unknown) => showAiToast(t("srs.failed", { error: explainError(e) }), "error"));
    setShown(false);
    setPos((p) => p + 1);
  };
  const close = () => void writes.current.then(onClose);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === " " && current && !shown) {
      e.preventDefault();
      setShown(true);
    } else if (shown && /^[1-4]$/.test(e.key)) answer(Number(e.key) as Rating);
  };
  const open = (link: string) => {
    const hash = link.indexOf("#");
    window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: hash < 0 ? { path: link } : { path: link.slice(0, hash), fragment: link.slice(hash + 1) } }));
    close();
  };

  const total = queue?.length ?? 0;
  return (
    <div ref={rootRef} className="hl-panel srs-panel" role="dialog" aria-label={t("srs.title")} tabIndex={-1} onKeyDown={onKey} data-testid="review-panel" data-open-ms={openMs === null ? undefined : Math.round(openMs)}>
      <div className="hl-head">
        <strong>{t("srs.title")}</strong>
        <HelpButton topic="workspace/review#reviewing" />
        <span className="hl-count" data-testid="review-progress">
          {queue ? t("srs.progress", { n: Math.min(pos + 1, total), total }) : t("srs.loading")}
        </span>
        <span className="hl-spacer" />
        <button type="button" onClick={close} aria-label={t("srs.close")}>
          ✕
        </button>
      </div>
      <div className="hl-list srs-body">
        {queue && !current && (total ? <p className="hl-empty" data-testid="review-done">{t("srs.done", { n: total })}</p> : <EmptyState testId="review-done" message={t("srs.empty")} action={learnHow("workspace/review#what-becomes-a-card")} />)}
        {current && (
          <div className="srs-card" data-testid="review-card" data-card-id={current.id}>
            <p className="srs-front" dir="auto">
              {current.kind === "highlight" ? `“${current.front}”` : current.front}
            </p>
            {!shown ? (
              <button type="button" onClick={() => setShown(true)} data-testid="review-show">
                {t(current.kind === "highlight" ? "srs.showSource" : "srs.showAnswer")}
              </button>
            ) : (
              <>
                {current.back && (
                  <p className="srs-back" dir="auto">
                    {current.back}
                  </p>
                )}
                <p className="hl-meta">
                  <button type="button" className="hl-quote" onClick={() => open(current.link)}>
                    {current.source.split("/").pop()}
                  </button>
                </p>
                <div className="srs-rate">
                  {([1, 2, 3, 4] as Rating[]).map((g) => (
                    <button key={g} type="button" onClick={() => answer(g)} data-testid={`review-rate-${g}`}>
                      {g} · {t(`srs.rate.${g}`)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

let close: (() => void) | null = null;

/** The palette's "Daily review" (run again to close). */
export function openDailyReview(): void {
  if (close) {
    close();
    return;
  }
  const opened = performance.now();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  close = () => {
    close = null;
    root.unmount();
    host.remove();
  };
  root.render(<ReviewPanel opened={opened} onClose={() => close?.()} />);
}
