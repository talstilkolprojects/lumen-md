/**
 * The cite dialog (plan W2.16), one for every source: ⌥⌘C (or the palette)
 * opens it over the note, it searches the whole library — the vault's
 * BibTeX and CSL-JSON and the Zotero copy — and Enter puts `[@key]` at the
 * cursor. With nothing typed the sources you cited last come first, so
 * shortcut → Enter cites the last one again (2 keystrokes); one ↓ picks the
 * next (3). Tab goes to the locator ("p. 10"); ⇧Enter writes `@key` for a
 * citation inside the sentence.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./strings";
import "./CiteDialog.css";
import { t } from "../i18n";
import { plainTitle } from "../data/citationStyles";
import { searchLibrary, type LibraryItem } from "./library";
import { HelpButton } from "../ui/HelpButton";

const RECENT = "lumen.cite.recent";
const SHOWN = 8;

export function recentKeys(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(RECENT, JSON.stringify([key, ...recentKeys().filter((k) => k !== key)].slice(0, 20)));
  } catch {
    /* private mode: no recent list */
  }
}

/** What the dialog inserts. */
export function citationText(key: string, locator: string, inText: boolean): string {
  const loc = locator.trim();
  if (inText) return loc ? `@${key} [${loc}]` : `@${key}`;
  return loc ? `[@${key}, ${loc}]` : `[@${key}]`;
}

export interface CiteDialogProps {
  load: () => Promise<LibraryItem[]>;
  onInsert: (text: string) => void;
  onClose: () => void;
  onSyncZotero?: () => Promise<void>;
}

export function CiteDialog({ load, onInsert, onClose, onSyncZotero }: CiteDialogProps) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [locator, setLocator] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const queryRef = useRef<HTMLInputElement>(null);

  const reload = () => load().then(setItems, () => setItems([]));
  useEffect(() => {
    void reload();
    queryRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => (items ? searchLibrary(items, query, recentKeys()).slice(0, SHOWN) : []), [items, query]);
  useEffect(() => setSel(0), [query]);

  const choose = (it: LibraryItem | undefined, inText: boolean) => {
    if (!it) return;
    remember(it.key);
    onInsert(citationText(it.key, locator, inText));
    onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[sel], e.shiftKey);
    }
  };

  return (
    <div className="cite-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cite-dialog" role="dialog" aria-modal="true" aria-label={t("cite.title")} data-testid="cite-dialog" onKeyDown={onKey}>
        <div className="cite-fields">
          <input ref={queryRef} dir="auto" type="search" value={query} placeholder={t("cite.search")} aria-label={t("cite.search")} onChange={(e) => setQuery(e.target.value)} data-testid="cite-search" />
          <input dir="auto" className="cite-locator" value={locator} placeholder={t("cite.locator")} aria-label={t("cite.locator")} onChange={(e) => setLocator(e.target.value)} data-testid="cite-locator" />
          <HelpButton topic="editor/citations" />
        </div>
        <ul className="cite-list" role="listbox" aria-label={t("cite.results")}>
          {items === null && <li className="cite-empty">{t("cite.loading")}</li>}
          {items && !items.length && <li className="cite-empty">{t("cite.noLibrary")}</li>}
          {items && items.length > 0 && !results.length && <li className="cite-empty">{t("cite.noMatch")}</li>}
          {results.map((it, i) => (
            <li
              key={it.key}
              role="option"
              aria-selected={i === sel}
              className={`cite-item${i === sel ? " sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => (e.preventDefault(), choose(it, e.shiftKey))}
              data-testid="cite-item"
              data-key={it.key}
            >
              <span className="cite-title" dir="auto">
                {plainTitle(it.record.title)}
              </span>
              <span className="cite-meta" dir="auto">
                {[it.record.authors.map((a) => a.family).join(", "), it.record.year].filter(Boolean).join(" · ")} · <code>@{it.key}</code> · {t(`cite.origin.${it.origin}`)}
              </span>
            </li>
          ))}
        </ul>
        <div className="cite-foot">
          <span>{t("cite.keys")}</span>
          {onSyncZotero && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onSyncZotero()
                  .then(reload)
                  .finally(() => setBusy(false));
              }}
              data-testid="cite-sync-zotero"
            >
              {busy ? t("cite.syncing") : t("cite.syncZotero")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Opening it over the app ──────────────────────────────────────── */

let open: { root: Root; host: HTMLElement } | null = null;

export async function openCiteDialog(): Promise<void> {
  if (open) return;
  const [{ loadLibrary }, { syncZoteroLibrary }] = await Promise.all([import("./library"), import("./run")]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  open = { root, host };
  const close = () => {
    if (!open) return;
    open.root.unmount();
    open.host.remove();
    open = null;
  };
  root.render(
    <CiteDialog
      load={loadLibrary}
      onClose={close}
      onSyncZotero={syncZoteroLibrary}
      onInsert={(text) => window.dispatchEvent(new CustomEvent("lumen-mobile-insert", { detail: { insert: text, cursorOffset: 0 } }))}
    />,
  );
}
