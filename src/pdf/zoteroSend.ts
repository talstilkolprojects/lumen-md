/**
 * W6.47 — "Send to Zotero" in the PDF reader: the highlights not sent yet go
 * to the PDF's item in the user's Zotero library as Zotero annotations
 * (../citations/zoteroAnnotations.ts). A lazy chunk, loaded on the click.
 *
 * Nothing leaves the device before the user confirms a dialog that names the
 * item and the number of highlights. The key is the one the read sync keeps
 * in the secret store (W5.23); the request goes through `fetch`, which the
 * privacy ledger records (and blocks under a local-only policy).
 */
import "./strings";
import "../citations/strings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import type { PdfAnnotation } from "./annotations";

export async function sendHighlightsToZotero(opts: { pdfPath: string; notePath: string; annotations: readonly PdfAnnotation[]; pageHeights: readonly number[] }): Promise<void> {
  const [{ getSecret, initSecretStore }, web, za, ws, { uiConfirm }] = await Promise.all([
    import("../lib/secretStore"),
    import("../citations/zoteroWeb"),
    import("../citations/zoteroAnnotations"),
    import("../storage/workspace"),
    import("../ui/PromptDialog"),
  ]);
  const read = async (p: string) => {
    try {
      return await ws.readWorkspaceFile(p);
    } catch {
      return null;
    }
  };
  await initSecretStore().catch(() => undefined);
  const key = getSecret(web.ZOTERO_KEY_SECRET);
  const stateText = await read(web.WEB_STATE_FILE);
  let state: import("../citations/zoteroWeb").ZoteroWebState | null = null;
  try {
    state = stateText ? (JSON.parse(stateText) as import("../citations/zoteroWeb").ZoteroWebState) : null;
  } catch {
    state = null;
  }
  if (!key || !state?.userID) return showAiToast(t("pdf.zotero.noLibrary"), "error");
  const parent = za.findAttachmentKey(state, opts.pdfPath, za.namedAttachment(await read(opts.notePath)));
  if (!parent) return showAiToast(t("pdf.zotero.noAttachment", { note: opts.notePath.split("/").pop() ?? opts.notePath }), "error");
  const sentFile = za.parseSent(await read(za.SENT_FILE));
  const { shortId } = await import("./annotations");
  const todo = opts.annotations.filter((a) => !sentFile.sent[shortId(a.id)]);
  if (!todo.length) return showAiToast(t("pdf.zotero.nothing"), "info");
  const parentItem = state.items[state.items[parent]?.parent ?? ""];
  const title = parentItem?.csl?.title ?? parentItem?.title ?? state.items[parent]?.attachment?.filename ?? parent;
  const ok = await uiConfirm({ title: t("pdf.zotero.send"), message: t("pdf.zotero.confirm", { n: todo.length, title }), okLabel: t("pdf.zotero.ok") });
  if (!ok) return;
  try {
    // privacy-ledger: research — window.fetch (wrapped by the ledger) to api.zotero.org only, after the user confirmed
    const r = await za.sendAnnotations({
      call: za.zoteroCall(key, (u, init) => fetch(u, init)),
      userID: state.userID,
      parentItem: parent,
      annotations: todo,
      pageHeights: opts.pageHeights,
      sentFile,
      consent: ok,
    });
    await ws.createWorkspaceFolder(".lumen").catch(() => undefined);
    await ws.writeWorkspaceFile(za.SENT_FILE, JSON.stringify(r.sentFile, null, 1) + "\n");
    showAiToast(r.failed.length ? t("pdf.zotero.partial", { n: r.sent, failed: r.failed.length }) : t("pdf.zotero.sent", { n: r.sent }), r.failed.length ? "error" : "success");
  } catch (e) {
    const err = e as Error & { reason?: string; name?: string };
    if (err.name === "PrivacyBlockedError") return showAiToast(t("cite.web.blocked"), "error");
    if (err.reason === "no-write-access") return showAiToast(t("pdf.zotero.noWrite"), "error");
    if (err.reason === "forbidden") return showAiToast(t("cite.web.forbidden"), "error");
    if (err.reason === "rate-limited") return showAiToast(t("cite.web.rateLimited"), "error");
    showAiToast(t("pdf.zotero.failed", { error: err.message }), "error");
  }
}
