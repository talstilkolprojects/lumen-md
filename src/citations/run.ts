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

/**
 * Plan W5.23: the library from zotero.org (Web API), read-only, for the web
 * app and phones. First run asks for the user's API key (kept in the secret
 * store); later runs fetch only what changed since the last library version.
 */
export async function syncZoteroWebLibrary(): Promise<void> {
  const [{ getSecret, setSecret, initSecretStore }, web, ws, { htmlToMarkdown }, { uiPrompt }] = await Promise.all([
    import("../lib/secretStore"),
    import("./zoteroWeb"),
    import("../storage/workspace"),
    import("../storage/fileFormats"),
    import("../ui/PromptDialog"),
  ]);
  await initSecretStore().catch(() => undefined);
  let key = getSecret(web.ZOTERO_KEY_SECRET);
  if (!key) {
    const entered = await uiPrompt({ title: t("cite.web.keyTitle"), message: t("cite.web.keyBody"), placeholder: t("cite.web.keyTitle") });
    if (!entered?.trim()) return;
    key = entered.trim();
    await setSecret(web.ZOTERO_KEY_SECRET, key);
  }
  try {
    let prev = web.emptyState();
    try {
      const saved = JSON.parse(await ws.readWorkspaceFile(web.WEB_STATE_FILE)) as typeof prev;
      if (saved?.v === 1) prev = saved;
    } catch {
      /* why: first sync */
    }
    // privacy-ledger: research — window.fetch (wrapped by the ledger) to api.zotero.org only
    const r = await web.syncZoteroWeb(prev, web.zoteroWebGet(key, (u, init) => fetch(u, init)));
    const csl = web.stateCsl(r.state);
    const text = JSON.stringify(csl, null, 1);
    const lib = fromCslJson(text, ZOTERO_FILE, "zotero");
    // fromCslJson keeps the order of the items that have a title: map each Zotero item to its [@key].
    const keyOf = new Map<string, string>();
    const titled = csl.filter((c) => !!c.title);
    titled.forEach((c, i) => {
      const itemKey = String(c.id).split("/").pop() ?? "";
      if (lib[i]) keyOf.set(itemKey, lib[i].key);
    });
    const notes = web.itemNotes(r.state, (k) => keyOf.get(k) ?? null, htmlToMarkdown);
    if (!r.notModified) {
      await ws.createWorkspaceFolder(".lumen").catch(() => undefined);
      await ws.writeWorkspaceFile(ZOTERO_FILE, text);
      if (notes.length) await ws.createWorkspaceFolder("Zotero").catch(() => undefined);
      for (const n of notes) await ws.writeWorkspaceFile(n.path, n.content);
      await ws.writeWorkspaceFile(web.WEB_STATE_FILE, JSON.stringify(r.state));
      invalidateLibrary();
      window.dispatchEvent(new Event("lumen-workspace-changed"));
    }
    showAiToast(
      r.notModified ? t("cite.web.upToDate", { n: lib.length }) : t("cite.web.synced", { n: lib.length, changed: r.changed, deleted: r.deleted, notes: notes.length }),
      "success",
    );
  } catch (e) {
    const err = e as Error & { reason?: string; name?: string };
    if (err.name === "PrivacyBlockedError") return showAiToast(t("cite.web.blocked"), "error");
    if (err.reason === "forbidden") {
      // A refused key is forgotten, so the next run asks again.
      await setSecret(web.ZOTERO_KEY_SECRET, null);
      return showAiToast(t("cite.web.forbidden"), "error");
    }
    if (err.reason === "no-library-access") return showAiToast(t("cite.web.noAccess"), "error");
    if (err.reason === "rate-limited") return showAiToast(t("cite.web.rateLimited"), "error");
    showAiToast(t("cite.web.failed", { error: err.message }), "error");
  }
}
