/**
 * The bodies of vaultLocation.ts's update commands (plan 14.4), loaded when
 * one runs (W4.9; train 5, startup budget after the W6.25 split).
 */
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import { explainError } from "../../lib/userError";

/** `app.checkUpdates` (moved from vaultLocation.ts, which loads this module when the command runs; W4.9). */
export const checkUpdates = async (): Promise<void> => {
  const { checkForUpdate, installUpdate } = await import("../../desktop/updates");
  const { uiConfirm } = await import("../../ui/PromptDialog");
  try {
    const r = await checkForUpdate();
    if (r.state === "blocked-local-only") return showAiToast(t("update.localOnly"), "info");
    if (r.state === "not-configured") return showAiToast(t("update.notConfigured"), "info");
    if (r.state === "up-to-date") return showAiToast(t("update.upToDate", { version: r.current }), "success");
    if (r.state !== "available") return;
    const ok = await uiConfirm({ title: t("update.available.title", { version: r.version }), message: r.notes || t("update.available.body", { current: r.current, version: r.version }), okLabel: t("update.install") });
    if (ok) await installUpdate();
  } catch (e) {
    showAiToast(t("update.failed", { message: explainError(e) }), "error");
  }
};

/** `app.updateChannel` (moved from vaultLocation.ts, which loads this module when the command runs; W4.9). */
export const chooseUpdateChannel = async (): Promise<void> => {
  const { setUpdateChannel, updateChannel } = await import("../../desktop/updates");
  const next = updateChannel() === "beta" ? "stable" : "beta";
  setUpdateChannel(next);
  showAiToast(next === "beta" ? t("update.channel.beta") : t("update.channel.stable"), "info");
};
