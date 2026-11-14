/**
 * The weekly beta report reminder (plan W6.31): a toast, only for a tester
 * who joined, asked for the weekly report, and has not sent one this week.
 * Its action opens the beta panel; nothing is sent from here.
 */
import { t } from "../i18n";
import "./strings";
import { useToastStore } from "../store/useToastStore";

export function remindBetaWeekly(): void {
  useToastStore.getState().push({
    kind: "info",
    title: t("beta.reminder"),
    body: t("beta.reminder.body"),
    action: { label: t("beta.reminder.open"), run: () => void window.dispatchEvent(new CustomEvent("lumen-open-beta")) },
  });
}
