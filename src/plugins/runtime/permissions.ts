/**
 * Capabilities in plain language (plan W1.20): what the install screen
 * says each permission lets a plugin do.
 */
import "./trustStrings";
import { t } from "../../i18n";
import type { ScanFinding } from "./scan";

/** Permissions that reach beyond the plugin itself: the user's notes, the clipboard, the network. */
const SENSITIVE = new Set(["document:write", "vault:read", "vault:write", "clipboard:write", "bases:read", "bases:write"]);

const NETWORK = "network:";

export function isSensitive(cap: string): boolean {
  return SENSITIVE.has(cap) || cap.startsWith(NETWORK);
}

/** "Read the note that is open", "Connect to https://example.com — and nowhere else", … */
export function describeCapability(cap: string): string {
  // The manifest check (manifest.ts) only lets an exact https origin through.
  if (cap.startsWith(NETWORK)) return t("pluginTrust.cap.network", { origin: cap.slice(NETWORK.length) });
  return t(`pluginTrust.cap.${cap.replace(/:/g, "-")}`);
}

/** The approval screen for one `lumen.bases.update` call (W6.46): who, how many notes, which properties, a few of them. */
export function describeBasesUpdate(plugin: string, s: { notes: number; properties: readonly string[]; sample: readonly string[] }): { title: string; message: string; ok: string } {
  const more = s.notes > s.sample.length ? `\n${t("pluginTrust.bases.more", { n: s.notes - s.sample.length })}` : "";
  return {
    title: t("pluginTrust.bases.title", { name: plugin, n: s.notes }),
    message: `${t("pluginTrust.bases.body", { properties: s.properties.join(", ") })}\n${s.sample.map((p) => `• ${p}`).join("\n")}${more}`,
    ok: t("pluginTrust.bases.ok", { n: s.notes }),
  };
}

/** The scan findings as short notes for the card. */
export function describeFindings(findings: readonly ScanFinding[]): string {
  return [...new Set(findings.map((f) => t(`pluginTrust.rule.${f.rule}`)))].join(" · ");
}

/** A prefilled GitHub issue for a plugin version. */
export function reportUrl(id: string, version: string): string {
  const title = `Plugin report: ${id} ${version}`;
  const body = `Plugin: ${id}\nVersion: ${version}\n\nWhat happened:\n`;
  return `https://github.com/talstilkol/lumen-md/issues/new?labels=plugin-report&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
