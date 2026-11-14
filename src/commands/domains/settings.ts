/** Optional panels (security, theme, fine-tuning, tags) and plan / billing commands. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { canPurchasePlans, manageBilling, upgradeTo } from "../../billing/planActions";
import type { CommandContext } from "./context";
import { airplaneFlagOn } from "../../privacy/airplaneBoot";
import { showAiToast } from "../../ui/AiToast";

/** Panels only some builds mount: listed only when App passes their setter. */
export function buildOptionalPanelCommands({ setTemplateGalleryOpen, setAuditLogOpen, setOrgSettingsOpen, setTrustedKeysOpen, setThemeSettingsOpen, setFineTuneOpen, setTagsPanelOpen, theme }: CommandContext): Command[] {
  return [
    ...(setTemplateGalleryOpen
      ? [
          {
            id: "templates.open",
            label: t("cmd.templates.open"),
            hint: t("cmd.templates.open.hint"),
            icon: cmdIcons.Sparkles,
            group: t("group.view"),
            action: () => setTemplateGalleryOpen(true),
          },
        ]
      : []),
    ...(setAuditLogOpen
      ? [
          {
            id: "audit.open",
            label: t("cmd.audit.open"),
            hint: t("cmd.audit.open.hint"),
            icon: cmdIcons.Sparkles,
            group: t("group.security"),
            action: () => setAuditLogOpen(true),
          },
        ]
      : []),
    ...(setOrgSettingsOpen
      ? [
          {
            id: "settings.organization",
            label: t("cmd.settings.organization"),
            hint: t("cmd.settings.organization.hint"),
            icon: cmdIcons.Sparkles,
            group: t("group.security"),
            action: () => setOrgSettingsOpen(true),
          },
        ]
      : []),
    ...(setTrustedKeysOpen
      ? [
          {
            id: "settings.trustedKeys",
            label: t("cmd.settings.trustedKeys"),
            hint: t("cmd.settings.trustedKeys.hint"),
            icon: cmdIcons.Sparkles,
            group: t("group.security"),
            action: () => setTrustedKeysOpen(true),
          },
        ]
      : []),
    {
      id: "settings.trustedRepos",
      label: t("cmd.settings.trustedRepos"),
      hint: t("cmd.settings.trustedRepos.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.security"),
      action: async () => (await import("../../ui/TrustedReposDialog")).openTrustedReposDialog(),
    },
    ...(setThemeSettingsOpen
      ? [
          {
            id: "settings.theme",
            label: t("cmd.settings.theme"),
            hint: t("cmd.settings.theme.hint"),
            icon: theme === "dark" ? cmdIcons.Moon : cmdIcons.Sun,
            group: t("group.view"),
            action: () => setThemeSettingsOpen(true),
          },
        ]
      : []),
    {
      id: "view.readingOptions",
      label: t("cmd.view.readingOptions"),
      hint: t("cmd.view.readingOptions.hint"),
      icon: cmdIcons.FileText,
      group: t("group.view"),
      action: () => window.dispatchEvent(new Event("lumen-open-reading")),
    },
    ...(setFineTuneOpen
      ? [
          {
            id: "ai.fineTune",
            label: t("cmd.fineTune.open"),
            hint: t("cmd.fineTune.open.hint"),
            icon: cmdIcons.Sparkles,
            group: t("group.ai"),
            action: () => setFineTuneOpen(true),
          },
        ]
      : []),
    ...(setTagsPanelOpen
      ? [
          {
            id: "view.tags",
            label: t("cmd.view.tags"),
            hint: t("cmd.view.tags.hint"),
            icon: cmdIcons.Link,
            group: t("group.view"),
            action: () => setTagsPanelOpen(true),
          },
        ]
      : []),
  ];
}

/** Plans (billing builds only). */
export function buildBillingCommands(): Command[] {
  return [
    ...(canPurchasePlans()
      ? [
          { id: "billing.upgradePro", label: t("cmd.billing.upgradePro"), action: () => void upgradeTo("pro") },
          { id: "billing.upgradeTeam", label: t("cmd.billing.upgradeTeam"), action: () => void upgradeTo("team") },
          { id: "billing.manage", label: t("cmd.billing.manage"), action: () => void manageBilling() },
          {
            id: "billing.managePersonal",
            label: t("cmd.billing.managePersonal"),
            action: () => void manageBilling("personal"),
          },
        ].map((c) => ({ ...c, icon: cmdIcons.Sparkles, group: t("group.tools") }))
      : []),
  ];
}

/** Airplane mode and the network monitor (plan W5.9); both load on use. */
export function buildAirplaneCommands(): Command[] {
  return [
    {
      id: "privacy.airplane",
      label: t("cmd.airplane.toggle"),
      hint: t(airplaneFlagOn() ? "cmd.airplane.hint.on" : "cmd.airplane.hint.off"),
      icon: cmdIcons.Network,
      group: t("group.security"),
      action: async () => {
        // why: the state when the command runs, not when the list was built
        const ui = await import("../../privacy/NetworkMonitor");
        if (airplaneFlagOn()) return ui.confirmAirplaneOff();
        ui.turnAirplaneOn();
        showAiToast(t("airplane.toast.on"), "info");
      },
    },
    {
      id: "privacy.networkMonitor",
      label: t("cmd.airplane.monitor"),
      hint: t("cmd.airplane.monitor.hint"),
      icon: cmdIcons.Network,
      group: t("group.security"),
      action: () => {
        void import("../../privacy/NetworkMonitor").then((m) => m.openNetworkMonitor());
      },
    },
  ];
}
