/**
 * A code block whose language a plugin renders (plan 11.2): the plugin gets
 * the block's source and answers with a UI tree (validated in the host),
 * which the app renders. Lazy chunk, loaded only when such a block exists.
 */
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import type { UiNode } from "./uiTree";
import { UiTreeView } from "./UiTreeView";
import { openPluginNoteLink } from "./openNote";
import { pluginForLang } from "./rendererRegistry";

export default function PluginBlock({ lang, source }: { lang: string; source: string }) {
  const [tree, setTree] = useState<UiNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    void import("./manager")
      .then(({ renderBlock }) => renderBlock(lang, source))
      .then(
        (t2) => live && setTree(t2),
        (e: Error) => live && setError(e.message),
      );
    return () => {
      live = false;
    };
  }, [lang, source]);
  const pluginId = pluginForLang(lang) ?? "";
  if (error)
    return (
      <div role="note" data-plugin-block={lang} style={{ fontSize: 12, opacity: 0.8 }}>
        {t("plugins.block.failed", { error })}
        <pre dir="ltr">
          <code>{source}</code>
        </pre>
      </div>
    );
  if (!tree) return <div data-plugin-block={lang} aria-busy="true" style={{ fontSize: 12, opacity: 0.6 }}>{t("plugins.block.loading")}</div>;
  return (
    <div data-plugin-block={lang} data-plugin-id={pluginId} style={{ border: "1px solid hsl(var(--border))", borderRadius: 8, padding: 8 }}>
      <UiTreeView
        node={tree}
        onOpenNote={(target) => void openPluginNoteLink(target)}
        onEvent={(e) => void import("./manager").then(({ sendUiEvent }) => sendUiEvent(pluginId, { scope: "block", ...e }))}
      />
    </div>
  );
}
