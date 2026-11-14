/**
 * Plan W6.9: the old address after production moves host.
 *
 * Lumen keeps the notes in this browser's storage for this origin (OPFS /
 * IndexedDB), so moving production from lumen-md.vercel.app to another origin
 * cannot move them, and a plain redirect would hide them. A build for the old
 * origin is made with VITE_MOVED_TO=<new origin> (docs self-hosting/cut-over):
 *
 *   - a browser that never used the app here (empty localStorage, checked in
 *     src/main.tsx before anything is written) goes straight to the same path
 *     on the new origin;
 *   - anyone else keeps the app here and gets this banner: download every note
 *     as one .zip (the vault export), then open the new address and import it.
 *
 * Normal builds have no VITE_MOVED_TO, so src/main.tsx's branch and this
 * chunk are not in them. Strings travel with this chunk (src/i18n/lazy/hostmove.json).
 */
import english from "../i18n/lazy/hostmove.json";
import { isRTL, registerEnglish, t } from "../i18n";
import { moveTarget } from "./moveTarget";

registerEnglish(english);

const DISMISSED = "lumen.hostMove.later";

/** The banner for a browser that has notes here. Returns it (tests), or null when there is nothing to show. */
export function showMoveBanner(movedTo: string, doc: Document = document): HTMLElement | null {
  const target = moveTarget(movedTo, doc.location);
  if (!target) return null;
  try {
    if (sessionStorage.getItem(DISMISSED) === "1") return null;
  } catch {
    /* why: storage blocked: show it */
  }
  const host = new URL(target).host;
  const bar = doc.createElement("div");
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", t("pwa.move.title", { host }));
  bar.dir = isRTL() ? "rtl" : "ltr";
  bar.className = "lumen-host-move";
  bar.style.cssText =
    "position:fixed;inset-inline:0;top:0;z-index:2147483000;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;" +
    "padding:10px 16px;background:Canvas;color:CanvasText;border-bottom:2px solid Highlight;font:14px/1.4 system-ui,sans-serif";
  const text = doc.createElement("p");
  text.style.cssText = "margin:0;flex:1 1 320px";
  const title = doc.createElement("strong");
  title.textContent = t("pwa.move.title", { host });
  text.append(title, doc.createTextNode(" " + t("pwa.move.body")));
  const status = doc.createElement("span");
  status.setAttribute("role", "status");
  const download = doc.createElement("button");
  download.type = "button";
  download.textContent = t("pwa.move.download");
  download.addEventListener("click", () => {
    download.disabled = true;
    void exportAndSave(doc)
      .then((n) => (status.textContent = t("pwa.move.downloaded", { count: n })))
      .catch((e: unknown) => (status.textContent = t("pwa.move.failed", { error: e instanceof Error ? e.message : String(e) })))
      .finally(() => (download.disabled = false));
  });
  const open = doc.createElement("a");
  open.href = target;
  open.rel = "noopener";
  open.textContent = t("pwa.move.open", { host });
  const later = doc.createElement("button");
  later.type = "button";
  later.textContent = t("pwa.move.later");
  later.addEventListener("click", () => {
    try {
      sessionStorage.setItem(DISMISSED, "1");
    } catch {
      /* why: storage blocked: hidden for this page only */
    }
    bar.remove();
  });
  bar.append(text, download, open, later, status);
  doc.body.prepend(bar);
  return bar;
}

async function exportAndSave(doc: Document): Promise<number> {
  const { exportVaultZip } = await import("../storage/exportAll");
  const { bytes, files } = await exportVaultZip();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = `lumen-notes-${new Date().toISOString().slice(0, 10)}.zip`;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return files;
}
