/**
 * The Israeli academic calendar (plan W7.8), in the palette: choose the
 * institution and year (the daily note's {{academic}} line follows it), and
 * export that year as an ICS file. Nothing goes over the network: the data
 * is in the app.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { uiAlert, uiSelect } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";

const academic = () => import("../../academic/app");

export function buildAcademicCommands(): Command[] {
  const group = t("group.tools");
  return [
    {
      id: "academic.choose",
      label: t("cmd.academic.choose"),
      hint: t("cmd.academic.choose.hint"),
      icon: cmdIcons.FileText,
      group,
      action: async () => {
        const a = await academic();
        const pick = await uiSelect({
          message: t("academic.pick"),
          choices: [{ value: "", label: t("academic.none") }, ...a.CALENDARS.map((c) => ({ value: `${c.institution.id}/${c.year}`, label: `${c.institution.he} ${c.label}${c.verified ? "" : ` (${t("academic.unverified")})`}` }))],
        });
        if (pick === null) return;
        const c = a.CALENDARS.find((x) => `${x.institution.id}/${x.year}` === pick) ?? null;
        a.choose(c);
        if (c && !c.verified) await uiAlert({ message: t("academic.chosenUnverified", { name: c.institution.he }) });
        else if (c) useToastStore.getState().push({ kind: "success", title: t("academic.chosen", { name: `${c.institution.he} ${c.label}` }) });
      },
    },
    {
      id: "academic.ics",
      label: t("cmd.academic.ics"),
      hint: t("cmd.academic.ics.hint"),
      icon: cmdIcons.Download,
      group,
      action: async () => {
        const a = await academic();
        const c = a.chosen();
        if (!c) {
          await uiAlert({ message: t("academic.noChoice") });
          return;
        }
        if (!c.verified) {
          await uiAlert({ message: t("academic.chosenUnverified", { name: c.institution.he }) });
          return;
        }
        a.downloadIcs(c);
        useToastStore.getState().push({ kind: "success", title: t("academic.exported", { file: `${c.institution.id}-${c.year}.ics` }) });
      },
    },
  ];
}
