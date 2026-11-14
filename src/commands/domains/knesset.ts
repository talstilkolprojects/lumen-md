/**
 * Knesset sources (plan W7.5), in the palette:
 *
 *  - "Cite a law (Knesset)…": the selection, the current line or a typed
 *    name ("חוק הגנת הפרטיות", "[[חוק:חופש המידע]]", a Basic Law) becomes
 *    a citation with the Knesset record link and its rights (§6). A saved
 *    law is found with no request; otherwise the name — and only the name —
 *    goes to knesset.gov.il after the user confirms, through the privacy
 *    ledger. "Save for offline" keeps the law in Sources/Knesset/Laws.
 *  - "Cite a bill (Knesset)…": the same for KNS_Bill.
 *  - "Quote from this committee protocol": the selected words in an open
 *    protocol, with the speaker, the session date and the page.
 *  - "Ask the law…": a local search of the saved laws' sections.
 *
 * Knesset sources start off: the first use asks to turn them on.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";

// The command bodies load on first use (knessetActions.ts): the palette lists these commands at start-up (W4.9).
export function buildKnessetCommands(ctx: CommandContext): Command[] {
  const group = t("group.insert");
  return [
    {
      id: "sources.knessetLaw",
      label: t("cmd.sources.knessetLaw"),
      hint: t("cmd.sources.knessetLaw.hint"),
      icon: cmdIcons.Quote,
      group,
      action: () => import("./knessetActions").then((m) => m.knessetLaw(ctx)),
    },
    {
      id: "sources.knessetBill",
      label: t("cmd.sources.knessetBill"),
      hint: t("cmd.sources.knessetBill.hint"),
      icon: cmdIcons.FileText,
      group,
      action: () => import("./knessetActions").then((m) => m.knessetBill(ctx)),
    },
    {
      id: "sources.knessetProtocol",
      label: t("cmd.sources.knessetProtocol"),
      hint: t("cmd.sources.knessetProtocol.hint"),
      icon: cmdIcons.Quote,
      group,
      action: () => import("./knessetActions").then((m) => m.knessetProtocol(ctx)),
    },
    {
      id: "sources.askLaw",
      label: t("cmd.sources.askLaw"),
      hint: t("cmd.sources.askLaw.hint"),
      icon: cmdIcons.FileText,
      group,
      action: () => import("./knessetActions").then((m) => m.askLaw(ctx)),
    },
  ];
}
