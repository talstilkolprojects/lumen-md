/**
 * The weekly usage report reminder (plan W4.26): a toast, only when the user
 * turned the reminder on and a week has passed. Its action opens the dialog;
 * nothing is sent from here.
 */
import { t } from "../i18n";
import "./strings";
import { useToastStore } from "../store/useToastStore";

export function remindWeekly(): void {
  useToastStore.getState().push({
    kind: "info",
    title: t("usage.reminder"),
    body: t("usage.reminder.body"),
    action: { label: t("usage.reminder.open"), run: () => void import("../ui/UsageDialog").then((m) => m.openUsage()) },
  });
}
