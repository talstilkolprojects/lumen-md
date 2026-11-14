/** The "What's new" dialog (plan 14.6): the version's notes, rendered like a note, in the interface's language. */
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./strings";
import "./WhatsNewDialog.css";
import { t } from "../i18n";
import { HelpButton } from "../ui/HelpButton";

export interface ShownNotes {
  version: string;
  date: string | null;
  markdown: string;
  translated: boolean;
}

export function WhatsNewDialog({ notes, version, render, onClose }: { notes: ShownNotes | null; version: string; render: (md: string) => Promise<ReactNode>; onClose: () => void }) {
  const [body, setBody] = useState<ReactNode>(null);
  useEffect(() => {
    let live = true;
    if (notes) void render(notes.markdown).then((n) => live && setBody(n));
    return () => {
      live = false;
    };
  }, [notes, render]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="wn-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wn-dialog" role="dialog" aria-modal="true" aria-labelledby="wn-title" data-testid="whats-new" data-version={notes?.version ?? version}>
        <h2 id="wn-title">{t("whatsNew.title", { version: notes?.version ?? version })}</h2>
        <HelpButton topic="getting-started/whats-new" />
        {notes?.date && <p className="wn-date">{notes.date}</p>}
        {notes && !notes.translated && <p className="wn-note">{t("whatsNew.untranslated")}</p>}
        <div className="wn-body markdown-body" dir="auto">
          {/* empty-allow: no release notes for this version is a fact about the build, and Close follows */}
          {notes ? body ?? t("whatsNew.loading") : t("whatsNew.none")}
        </div>
        <div className="wn-actions">
          <button type="button" onClick={onClose} autoFocus data-testid="whats-new-close">
            {t("whatsNew.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function showWhatsNew(notes: ShownNotes | null, version: string): void {
  if (document.querySelector('[data-testid="whats-new"]')) return;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  const render = async (md: string) => (await import("../renderer/pipeline")).renderMarkdown(md, () => document.documentElement.classList.contains("dark"));
  root.render(<WhatsNewDialog notes={notes} version={version} render={render} onClose={close} />);
}
