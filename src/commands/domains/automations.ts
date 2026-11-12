/**
 * No-code automations (plan W5.24) in the palette: build a "when … then …"
 * rule in a few choices, a dry run on the open note (nothing is written),
 * and undo of the last run. Everything is loaded on first use.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { uiAlert, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";
import type { CommandContext } from "./context";
import type { Action, Rule, Trigger } from "../../automations/engine";

const load = () => import("../../automations/app");
const ask = async (key: string, defaultValue = "") => (await uiPrompt({ message: t(key), defaultValue }))?.trim() ?? null;
const fail = (e: unknown) => useToastStore.getState().push({ kind: "error", title: t("automations.failed", { error: (e as Error).message }) });

async function buildRule(): Promise<Rule | null> {
  const w = await uiSelect({ message: t("automations.pick.trigger"), choices: ["created", "tagAdded", "propertyChanged", "daily"].map((v) => ({ value: v, label: t(`automations.trigger.${v}`) })) });
  if (!w) return null;
  let when: Trigger;
  if (w === "created") when = { kind: "created", folder: (await ask("automations.ask.folder")) || undefined };
  else if (w === "tagAdded") {
    const tag = await ask("automations.ask.tag");
    if (!tag) return null;
    when = { kind: "tagAdded", tag };
  } else if (w === "propertyChanged") {
    const key = await ask("automations.ask.key");
    if (!key) return null;
    when = { kind: "propertyChanged", key, value: (await ask("automations.ask.value")) || undefined };
  } else when = { kind: "daily" };
  const a = await uiSelect({ message: t("automations.pick.action"), choices: ["move", "tag", "template", "appendDaily"].map((v) => ({ value: v, label: t(`automations.action.${v}`) })) });
  if (!a) return null;
  const value = await ask(a === "move" ? "automations.ask.folder" : a === "tag" ? "automations.ask.tag" : a === "template" ? "automations.ask.template" : "automations.ask.text", a === "appendDaily" ? "- {{link}}" : "");
  if (value === null || (a !== "move" && !value)) return null;
  const action: Action = a === "move" ? { kind: "move", folder: value } : a === "tag" ? { kind: "tag", tag: value } : a === "template" ? { kind: "template", template: value } : { kind: "appendDaily", text: value };
  const name = (await ask("automations.ask.name", `${t(`automations.trigger.${w}`)} → ${t(`automations.action.${a}`)}`)) || w;
  return { id: `r${Date.now().toString(36)}`, name, enabled: true, when, then: [action] };
}

export function buildAutomationCommands({ liveDoc }: CommandContext): Command[] {
  const group = t("group.tools");
  return [
    {
      id: "automations.new",
      label: t("cmd.automations.new"),
      hint: t("cmd.automations.new.hint"),
      icon: cmdIcons.Workflow,
      group,
      action: async () => {
        try {
          const rule = await buildRule();
          if (!rule) return;
          const m = await load();
          await m.saveRules([...(await m.loadRules()), rule]);
          await m.startAutomationsIfConfigured();
          useToastStore.getState().push({ kind: "success", title: t("automations.created", { name: rule.name }) });
        } catch (e) {
          fail(e);
        }
      },
    },
    {
      id: "automations.dryRun",
      label: t("cmd.automations.dryRun"),
      hint: t("cmd.automations.dryRun.hint"),
      icon: cmdIcons.Workflow,
      group,
      action: async () => {
        const doc = liveDoc();
        if (!doc.workspaceName) return;
        try {
          const p = await (await load()).dryRun({ kind: "created", path: doc.workspaceName, text: doc.content });
          if (!p.changes.length) {
            await uiAlert({ message: t("automations.dryRun.none") });
            return;
          }
          const lines = p.changes.map((c) => (c.kind === "move" ? `• ${c.rule}: ${c.from} → ${c.to}` : `• ${c.rule}: ${c.path}`));
          await uiAlert({ message: [t("automations.dryRun.title"), ...lines, ...(p.stopped.length ? [t("automations.dryRun.stopped", { count: p.stopped.length })] : [])].join("\n") });
        } catch (e) {
          fail(e);
        }
      },
    },
    {
      id: "automations.undo",
      label: t("cmd.automations.undo"),
      hint: t("cmd.automations.undo.hint"),
      icon: cmdIcons.Workflow,
      group,
      action: async () => {
        try {
          const r = await (await load()).undoLast();
          if (r.ok) useToastStore.getState().push({ kind: "success", title: t("automations.undone", { event: r.entry.event }) });
          else await uiAlert({ message: r.reason === "none" ? t("automations.undo.none") : t("automations.undo.changed", { path: r.path }) });
        } catch (e) {
          fail(e);
        }
      },
    },
  ];
}
