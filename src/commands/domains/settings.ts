/** Optional panels (security, theme, fine-tuning, tags) and plan / billing commands. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { canPurchasePlans, manageBilling, upgradeTo } from "../../billing/planActions";
import type { CommandContext } from "./context";

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
