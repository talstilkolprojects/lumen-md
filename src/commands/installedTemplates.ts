/**
 * ⌘K "Insert template" entries for marketplace templates the user has
 * installed into the workspace (`templates/<id>.md` in OPFS — see
 * `installTemplate()` in storage/templateMarketplace.ts).
 *
 * `useInstalledTemplates()` loads the list asynchronously on mount and
 * reloads whenever an install fires `TEMPLATES_CHANGED_EVENT`;
 * `buildInstalledTemplateCommands()` turns that list into palette commands
 * that read the body lazily on selection (so the palette never holds
 * template bodies in memory).
 */

import { useEffect, useState } from "react";
import type { Command } from "../ui/CommandPalette";
import { cmdIcons } from "../ui/CommandPalette";
import {
  listInstalledTemplates,
  readInstalledTemplate,
  TEMPLATES_CHANGED_EVENT,
  type InstalledTemplate,
} from "../storage/templateMarketplace";
import { log } from "../lib/logger";

export function useInstalledTemplates(): InstalledTemplate[] {
  const [templates, setTemplates] = useState<InstalledTemplate[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listInstalledTemplates()
        .then((list) => {
          if (!cancelled) setTemplates(list);
        })
        .catch((e) => log.warn("installed templates: list failed", e));
    };
    load();
    window.addEventListener(TEMPLATES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(TEMPLATES_CHANGED_EVENT, load);
    };
  }, []);
  return templates;
}

/** Let the user pick one Markdown file (to import as a template); null when cancelled. */
export function pickMarkdownFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,text/markdown";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export interface InstalledTemplateCommandDeps {
  /** Localized group label, e.g. t("group.templates"). */
  groupLabel: string;
  /** Hint shown next to each entry (e.g. "Installed"). */
  hint: string;
  /** Apply the template body as a new, dirty document. */
  apply: (name: string, content: string) => void;
  /** Surface a load failure to the user. */
  onError?: (error: Error) => void;
}

export function buildInstalledTemplateCommands(
  templates: InstalledTemplate[],
  deps: InstalledTemplateCommandDeps,
): Command[] {
  return templates.map((tpl) => ({
    id: `template.installed.${tpl.id}`,
    label: `${deps.groupLabel}: ${tpl.name}`,
    hint: deps.hint,
    icon: cmdIcons.FileText,
    group: deps.groupLabel,
    action: () => {
      readInstalledTemplate(tpl)
        .then((content) => deps.apply(tpl.name, content))
        .catch((e: unknown) => {
          log.error("installed template: read failed", e);
          deps.onError?.(e instanceof Error ? e : new Error(String(e)));
        });
    },
  }));
}
