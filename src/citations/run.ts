/** Citation commands (plan W2.16): sync the local Zotero library into the vault. */
import "./strings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { ZOTERO_FILE, fromCslJson, invalidateLibrary } from "./library";
import { desktopZoteroGet, zoteroCslItems } from "./zoteroSync";

export async function syncZoteroLibrary(): Promise<void> {
  try {
    const items = await zoteroCslItems(await desktopZoteroGet());
    const text = JSON.stringify(items, null, 1);
    const ws = await import("../storage/workspace");
    await ws.createWorkspaceFolder(".lumen").catch(() => undefined);
    await ws.writeWorkspaceFile(ZOTERO_FILE, text);
    invalidateLibrary();
    showAiToast(t("cite.synced", { n: fromCslJson(text, ZOTERO_FILE, "zotero").length }), "success");
  } catch (e) {
    const err = e as Error & { reason?: string };
    const key = err.reason === "disabled" ? "cite.zotero.disabled" : err.reason === "browser" ? "cite.zotero.browser" : err.reason === "not-running" ? "cite.zotero.notRunning" : "cite.zotero.failed";
    showAiToast(t(key, { error: err.message }), "error");
  }
}
