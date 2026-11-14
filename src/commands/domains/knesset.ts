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
import { uiAlert, uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";
import type { CommandContext } from "./context";
import { explainError } from "../../lib/userError";
import { isSourceEnabled, setSourceEnabled } from "../../sources/open/gate";

type Knesset = typeof import("../../sources/knesset/app");
const knesset = (): Promise<Knesset> => import("../../sources/knesset/app");

function selection(ctx: CommandContext): { text: string; from: number; to: number; empty: boolean } | null {
  const view = ctx.getEditorView?.();
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from !== to) return { text: view.state.sliceDoc(from, to), from, to, empty: false };
  const line = view.state.doc.lineAt(from);
  return { text: line.text, from: line.from, to: line.to, empty: true };
}

/** On, or turned on now by the user; false when they said no. */
async function ensureOn(): Promise<boolean> {
  if (isSourceEnabled("knesset")) return true;
  if (!(await uiConfirm({ message: t("knesset.enable") }))) return false;
  setSourceEnabled("knesset", true);
  return true;
}

const fail = (e: unknown) => useToastStore.getState().push({ kind: "error", title: t("knesset.failed", { error: explainError(e) }) });

export function buildKnessetCommands(ctx: CommandContext): Command[] {
  const group = t("group.insert");
  return [
    {
      id: "sources.knessetLaw",
      label: t("cmd.sources.knessetLaw"),
      hint: t("cmd.sources.knessetLaw.hint"),
      icon: cmdIcons.Quote,
      group,
      action: async () => {
        const k = await knesset();
        const here = selection(ctx);
        const mention = here ? k.lawMentionsIn(here.text)[0] : undefined;
        const name = mention ?? (await uiPrompt({ message: t("knesset.prompt"), defaultValue: "" }))?.trim();
        if (!name || !(await ensureOn())) return;
        let found;
        try {
          found = await k.findLaw(name, () => uiConfirm({ message: t("knesset.confirm", { name }) }));
        } catch (e) {
          fail(e);
          return;
        }
        if (found === null) return; // declined: nothing was sent
        let law = found.saved?.law ?? found.law;
        if (!law && found.candidates.length) {
          const pick = await uiSelect({ message: t("knesset.pick"), choices: found.candidates.map((c) => ({ value: String(c.id), label: c.name })) });
          law = found.candidates.find((c) => String(c.id) === pick) ?? null;
        }
        if (!law) {
          if (!found.candidates.length) await uiAlert({ message: t("knesset.noMatch", { name }) });
          return;
        }
        ctx.insertSnippet(` ${k.lawCitation(law)} `);
        const fromNetwork = found.from === "network" ? found.law ?? found.candidates.find((c) => c.id === law!.id) ?? null : null;
        useToastStore.getState().push({
          kind: "success",
          title: t("knesset.inserted", { name: law.name }),
          ...(fromNetwork
            ? {
                ttlMs: 12_000,
                action: {
                  label: t("knesset.saveOffline"),
                  run: () =>
                    void k.keepLaw(fromNetwork).then((path) => path && useToastStore.getState().push({ kind: "success", title: t("knesset.saved", { path }) }), fail),
                },
              }
            : {}),
        });
      },
    },
    {
      id: "sources.knessetBill",
      label: t("cmd.sources.knessetBill"),
      hint: t("cmd.sources.knessetBill.hint"),
      icon: cmdIcons.FileText,
      group,
      action: async () => {
        const k = await knesset();
        const here = selection(ctx);
        const name = (here && !here.empty ? here.text : await uiPrompt({ message: t("knesset.billPrompt"), defaultValue: "" }))?.trim();
        if (!name || !(await ensureOn())) return;
        let bills;
        try {
          bills = await k.findBills(name, () => uiConfirm({ message: t("knesset.confirm", { name }) }));
        } catch (e) {
          fail(e);
          return;
        }
        if (bills === null) return;
        if (!bills.length) {
          await uiAlert({ message: t("knesset.noBills", { name }) });
          return;
        }
        const pick = await uiSelect({ message: t("knesset.billPick", { count: bills.length }), choices: bills.map((b) => ({ value: String(b.id), label: `${b.name}${b.knessetNum ? ` (${b.knessetNum})` : ""}` })) });
        const bill = bills.find((b) => String(b.id) === pick);
        if (!bill) return;
        const path = await k.keepBill(bill);
        ctx.insertSnippet(path ? ` [[${path.replace(/\.md$/, "")}|${bill.name}]] ` : ` ${bill.name} `);
        useToastStore.getState().push({ kind: "success", title: t("knesset.inserted", { name: bill.name }) });
      },
    },
    {
      id: "sources.knessetProtocol",
      label: t("cmd.sources.knessetProtocol"),
      hint: t("cmd.sources.knessetProtocol.hint"),
      icon: cmdIcons.Quote,
      group,
      action: async () => {
        const k = await knesset();
        const here = selection(ctx);
        if (!here || here.empty) {
          await uiAlert({ message: t("knesset.protocolSelect") });
          return;
        }
        const quote = k.quoteFromProtocol(ctx.liveDoc().content, here.text);
        if (!quote) {
          await uiAlert({ message: t("knesset.protocolNotFound") });
          return;
        }
        await navigator.clipboard?.writeText(quote).catch(() => undefined);
        ctx.insertSnippet(`\n\n${quote}\n`);
      },
    },
    {
      id: "sources.askLaw",
      label: t("cmd.sources.askLaw"),
      hint: t("cmd.sources.askLaw.hint"),
      icon: cmdIcons.FileText,
      group,
      action: async () => {
        const k = await knesset();
        const q = (await uiPrompt({ message: t("knesset.askPrompt"), defaultValue: "" }))?.trim();
        if (!q) return;
        const answers = await k.ask(q);
        if (!answers.length) {
          await uiAlert({ message: t("knesset.askNone") });
          return;
        }
        const pick = await uiSelect({
          message: t("knesset.askPick"),
          choices: answers.map((a, i) => ({ value: String(i), label: `${a.law.law.name} §${a.section.number}${a.verified ? "" : ` (${t("knesset.unverified")})`}: ${a.section.text.slice(0, 90)}` })),
        });
        const a = pick === null || pick === undefined ? null : answers[Number(pick)];
        if (a) ctx.insertSnippet(`\n\n${a.markdown}\n`);
      },
    },
  ];
}
