/**
 * The open-sources dialog (plan W7.24): one search over Sefaria, the
 * Knesset, data.gov.il / the CBS and the Ben-Yehuda library, with a rights
 * badge on every result, a filter by kind, and a switch per source.
 *
 * Local results appear as you type (nothing is sent). "Search online"
 * asks once, then queries only the sources that are on, through the
 * ledgered fetch. Keyboard: type, ↑/↓, Enter inserts, Alt+O searches online,
 * Esc closes; Tab reaches the filters and the switches.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n";
import "./strings";
import "../../citations/CiteDialog.css";
import "./OpenSourcesDialog.css";
import { enabledSources, setSourceEnabled, type OpenSourceId } from "./gate";
import { KINDS, merge, type Kind, type LocalSources, type OpenResult } from "./search";

export interface DialogDeps {
  /** Saved laws and the downloaded library (read from the vault once). */
  loadLocal: () => Promise<Omit<LocalSources, "enabled">>;
  searchLocal: (q: string, src: LocalSources, kind: Kind | null) => OpenResult[];
  /** The gated online search; null when the user declined. */
  searchOnline: (q: string, enabled: Record<OpenSourceId, boolean>, kind: Kind | null) => Promise<OpenResult[] | null>;
  /** The Markdown a result becomes (fetching what it needs, behind the same gate). null: nothing to insert. */
  insertion: (r: OpenResult) => Promise<string | null>;
  onInsert: (markdown: string) => void;
  onClose: () => void;
}

const SOURCES: readonly OpenSourceId[] = ["sefaria", "knesset", "datagov", "benyehuda"];

export function OpenSourcesDialog(d: DialogDeps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | null>(null);
  const [enabled, setEnabled] = useState(() => enabledSources());
  const [local, setLocal] = useState<Omit<LocalSources, "enabled"> | null>(null);
  const [online, setOnline] = useState<OpenResult[]>([]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void d.loadLocal().then(setLocal, () => setLocal({ laws: [], library: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setOnline([]);
    setSel(0);
  }, [query, kind]);

  const results = useMemo(() => (local ? merge(d.searchLocal(query, { ...local, enabled }, kind), online) : online), [d, local, query, kind, enabled, online]);

  const goOnline = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    setStatus(t("openSources.searching"));
    try {
      const r = await d.searchOnline(query, enabled, kind);
      if (r === null) setStatus(t("openSources.declined"));
      else {
        setOnline(r);
        setStatus(t("openSources.found", { count: r.length }));
      }
    } catch (e) {
      setStatus(t("openSources.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (r: OpenResult | undefined) => {
    if (!r || busy) return;
    setBusy(true);
    try {
      const md = await d.insertion(r);
      if (md) {
        d.onInsert(md);
        d.onClose();
      } else setStatus(t("openSources.declined"));
    } catch (e) {
      setStatus(t("openSources.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: OpenSourceId) => {
    setSourceEnabled(id, !enabled[id]);
    setEnabled(enabledSources());
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      d.onClose();
    } else if (e.key === "ArrowDown" && e.target === input.current) {
      e.preventDefault();
      setSel((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp" && e.target === input.current) {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && e.target === input.current) {
      e.preventDefault();
      if (results.length) void choose(results[sel]);
      else void goOnline();
    } else if (e.altKey && e.code === "KeyO") {
      e.preventDefault();
      void goOnline();
    }
  };

  const active = results[sel] ? `os-opt-${sel}` : undefined;
  return (
    <div className="cite-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && d.onClose()}>
      <div className="cite-dialog os-dialog" role="dialog" aria-modal="true" aria-labelledby="os-title" data-testid="open-sources" onKeyDown={onKey}>
        <h2 id="os-title" className="os-title">
          {t("openSources.title")}
        </h2>
        <div className="cite-fields">
          <input
            ref={input}
            dir="auto"
            type="search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="os-results"
            aria-activedescendant={active}
            aria-autocomplete="list"
            value={query}
            placeholder={t("openSources.placeholder")}
            aria-label={t("openSources.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="open-sources-query"
          />
          <button type="button" onClick={() => void goOnline()} disabled={busy || !query.trim()} data-testid="open-sources-online" aria-keyshortcuts="Alt+O">
            {t("openSources.online")}
          </button>
        </div>
        <div className="os-kinds" role="radiogroup" aria-label={t("openSources.kind")}>
          {[null, ...KINDS].map((k) => (
            <label key={k ?? "all"} className="os-kind">
              <input type="radio" name="os-kind" checked={kind === k} onChange={() => setKind(k)} />
              {t(`openSources.kind.${k ?? "all"}`)}
            </label>
          ))}
        </div>
        <ul id="os-results" className="cite-list" role="listbox" aria-label={t("openSources.results")}>
          {!results.length && <li className="cite-empty">{query.trim() ? t("openSources.noLocal") : t("openSources.hint")}</li>}
          {results.map((r, i) => (
            <li
              key={r.key}
              id={`os-opt-${i}`}
              role="option"
              aria-selected={i === sel}
              className={`cite-item${i === sel ? " sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => (e.preventDefault(), void choose(r))}
              data-testid="open-sources-item"
              data-rights={r.rights}
            >
              <span className="cite-title" dir="auto">
                {r.title}
              </span>
              <span className="cite-meta" dir="auto">
                {[t(`openSources.source.${r.source}`), r.detail].filter(Boolean).join(" · ")} {r.local ? `· ${t("openSources.onDevice")}` : ""}
              </span>
              <span className={`os-badge os-badge-${r.rights}`} data-testid="open-sources-badge">
                {t(`openSources.rights.${r.rights}`)}
              </span>
            </li>
          ))}
        </ul>
        <p className="os-status" role="status" aria-live="polite">
          {status}
        </p>
        <fieldset className="os-switches">
          <legend>{t("openSources.switches")}</legend>
          {SOURCES.map((id) => (
            <label key={id} className="os-switch">
              <input type="checkbox" checked={enabled[id]} onChange={() => toggle(id)} data-testid={`open-sources-switch-${id}`} />
              <span>{t(`openSources.source.${id}`)}</span>
              <span className="os-sends">{t(`openSources.sends.${id}`)}</span>
            </label>
          ))}
        </fieldset>
        <div className="cite-foot">
          <span>{t("openSources.keys")}</span>
        </div>
      </div>
    </div>
  );
}

/* ─── Opening it over the app ──────────────────────────────────────── */

let open: { root: Root; host: HTMLElement } | null = null;

export async function openSourcesDialog(): Promise<void> {
  if (open) return;
  const app = await import("./app");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  open = { root, host };
  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    if (!open) return;
    open.root.unmount();
    open.host.remove();
    open = null;
    opener?.focus?.();
  };
  root.render(
    <OpenSourcesDialog
      loadLocal={app.loadLocal}
      searchLocal={app.searchLocal}
      searchOnline={app.searchOnlineGated}
      insertion={app.insertion}
      onClose={close}
      onInsert={(text) => window.dispatchEvent(new CustomEvent("lumen-mobile-insert", { detail: { insert: `\n\n${text}\n`, cursorOffset: 0 } }))}
    />,
  );
}
