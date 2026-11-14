/**
 * The search dialog's "Images" tab (plan 6.7.3): images of the vault ranked
 * by a text query, on this device (SigLIP, ../ai/imageSearchService.ts).
 * Lazy: loaded only when the tab is opened.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import "../ai/imageSearchStrings";
import type { ImageHit } from "../ai/imageSearch";

interface Props {
  query: string;
  /** Open the image (the dialog inserts or shows it). */
  onPick: (path: string) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "working"; done: number; total: number }
  | { kind: "done"; hits: ImageHit[]; translated: string | null }
  | { kind: "unavailable"; reason: "noHost" | "declined" }
  | { kind: "error"; message: string };

function Thumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    void (async () => {
      try {
        const { readWorkspaceBlob } = await import("../storage/workspace");
        made = URL.createObjectURL(await readWorkspaceBlob(path));
        if (alive) setUrl(made);
      } catch {
        /* why: unreadable: the name is still shown */
      }
    })();
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return url ? <img src={url} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6 }} /> : <div style={{ width: "100%", aspectRatio: "1", borderRadius: 6, background: "hsl(var(--bg-subtle))" }} />;
}

export function ImageSearchPanel({ query, onPick }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    abort.current?.abort();
    if (!q) {
      setState({ kind: "idle" });
      return;
    }
    const ac = new AbortController();
    abort.current = ac;
    const timer = window.setTimeout(async () => {
      setState({ kind: "working", done: 0, total: 0 });
      try {
        const [{ searchImages, ImageSearchUnavailableError }, { uiConfirm }, i18n] = await Promise.all([import("../ai/imageSearchService"), import("./PromptDialog"), import("../i18n")]);
        try {
          const r = await searchImages(q, {
            consent: { confirm: uiConfirm, t: i18n.t, locale: i18n.getLocale() },
            signal: ac.signal,
            onProgress: (done, total) => !ac.signal.aborted && setState({ kind: "working", done, total }),
          });
          if (!ac.signal.aborted) setState({ kind: "done", hits: r.hits, translated: r.translated });
        } catch (e) {
          if (ac.signal.aborted || (e as Error)?.name === "AbortError") return;
          if (e instanceof ImageSearchUnavailableError) setState({ kind: "unavailable", reason: e.reason });
          else setState({ kind: "error", message: (e as Error).message });
        }
      } catch (e) {
        if (!ac.signal.aborted) setState({ kind: "error", message: (e as Error).message });
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query]);

  const muted = { fontSize: 12, color: "hsl(var(--fg-muted))", padding: "10px 12px" } as const;
  if (state.kind === "idle") return <div style={muted} data-testid="image-search-idle">{t("imageSearch.hint")}</div>;
  if (state.kind === "working")
    return (
      <div style={muted} role="status" aria-live="polite" data-testid="image-search-working">
        {state.total ? t("imageSearch.indexing", { done: state.done, total: state.total }) : t("imageSearch.searching")}
      </div>
    );
  if (state.kind === "unavailable") return <div style={muted} data-testid="image-search-unavailable">{t(`imageSearch.${state.reason}`)}</div>;
  if (state.kind === "error") return <div style={muted} role="alert">{t("imageSearch.failed", { error: state.message })}</div>;
  return (
    <div data-testid="image-search-results">
      {state.translated && <div style={muted}>{t("imageSearch.translated", { query: state.translated })}</div>}
      {state.hits.length === 0 ? (
        <div style={muted}>{t("imageSearch.none")}</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8, padding: 10 }}>
          {state.hits.map((h) => (
            <button key={h.path} type="button" onClick={() => onPick(h.path)} title={h.path} style={{ background: "transparent", border: "1px solid hsl(var(--border))", borderRadius: 8, padding: 4, cursor: "pointer", color: "inherit", textAlign: "start" }}>
              <Thumb path={h.path} />
              <div style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "ltr", unicodeBidi: "isolate" }}>{h.path.split("/").pop()}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
