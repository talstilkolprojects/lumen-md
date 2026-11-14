/** The knesset commands' bodies, loaded on first use (split out of knesset.ts for the startup budget, W4.9). */
import { t } from "../../i18n";
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

export async function knessetLaw(ctx: CommandContext): Promise<void> {
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
}

export async function knessetBill(ctx: CommandContext): Promise<void> {
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
}

export async function knessetProtocol(ctx: CommandContext): Promise<void> {
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
}

export async function askLaw(ctx: CommandContext): Promise<void> {
  const k = await knesset();
  const q = (await uiPrompt({ message: t("knesset.askPrompt"), defaultValue: "" }))?.trim();
  if (!q) return;
  const answers = await k.ask(q);
  if (!answers.length) {
    await uiAlert({ message: t("knesset.askNone") });
    return;
  }
  // Plan W10.B10: these are quotes from the law, not verified answers.
  const pick = await uiSelect({
    message: t("knesset.askPickQuote"),
    choices: answers.map((a, i) => ({ value: String(i), label: `${a.law.law.name} §${a.section.number}${a.quoteInLaw ? "" : ` (${t("knesset.quoteNotInCopy")})`}: ${a.section.text.slice(0, 90)}` })),
  });
  const a = pick === null || pick === undefined ? null : answers[Number(pick)];
  if (!a) return;
  // With a model on this device: a short answer from the section, checked by the critic.
  const answer = await k.answerLawQuestion(q, a, await k.localLawChat());
  const lines = [a.markdown];
  if (answer) {
    lines.push("", `**${t("knesset.answerLabel")}:** ${answer.claim}`, "", `_${answer.verified ? t("knesset.answerVerified", { section: a.section.number }) : t("knesset.answerNotVerified", { section: a.section.number })}_`);
  } else {
    lines.push("", `_${t("knesset.quoteNotAnswer")}_`);
  }
  ctx.insertSnippet(`\n\n${lines.join("\n")}\n`);
}
