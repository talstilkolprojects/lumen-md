/** Research agent, web clipper and citation check. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, getLocale } from "../../i18n";
import { uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { isAbort } from "../../ai/aiAbort";
import { openTemplateDoc } from "../openDoc";
import { cancellable, type CommandContext } from "./context";
import { explainError } from "../../lib/userError";

/** Save a clip into the library folder and open it (T34). Exported for tests; the work is in a lazy module. */
export async function saveClip(clip: { title: string; markdown: string }): Promise<void> {
  await (await import("../../research/clipSave")).saveClipToLibrary(clip, openTemplateDoc);
}

/**
 * Save a clip that came from the extension or a deep link (plan 4.15):
 * extracted, templated and checked for injected text, then written into its
 * template's folder and recorded as outside content. Exported for tests.
 */
export async function saveClipV2(payload: import("../../research/clipV2").ClipPayload): Promise<string | null> {
  const { buildClip } = await import("../../research/clipV2");
  const { libraryDir } = await import("../../research/clipper");
  const clip = await buildClip(payload, { library: libraryDir(getLocale()) });
  const { writeWorkspaceFile, workspaceHasEntry, isOPFSAvailable } = await import("../../storage/workspace");
  if (!isOPFSAvailable()) {
    openTemplateDoc(clip.fileName.replace(/\.md$/, ""), clip.markdown);
    return null;
  }
  const stem = clip.fileName.replace(/\.md$/, "");
  let path = `${clip.folder}/${clip.fileName}`;
  for (let i = 2; await workspaceHasEntry(path); i++) path = `${clip.folder}/${stem} (${i}).md`;
  await writeWorkspaceFile(path, clip.markdown);
  const { markUntrustedNote } = await import("../../agents/untrusted");
  markUntrustedNote(path, `clipped from ${clip.source}`);
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  useAppStore.getState().openTab({ name: path.split("/").pop()!, content: clip.markdown, workspaceName: path });
  showAiToast(t("clip.saved", { path }), "success");
  if (clip.flagged) showAiToast(t("clip.flagged", { count: clip.flagged }), "info");
  return path;
}

/** Research a question, clip a page or the clipboard, check citations, research settings. */
export function buildResearchCommands({ liveDoc }: CommandContext): Command[] {
  return [
    {
      id: "research.ask",
      label: t("cmd.research.ask"),
      hint: t("cmd.research.ask.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: async () => {
        const question = await uiPrompt({ message: t("research.question"), defaultValue: "" });
        if (!question?.trim()) return;
        try {
          const { runResearch, researchGoesOnline, hasWebConsent, grantWebConsent } = await import("../../research/agent");
          // T34: the first web research asks once; only the query is sent.
          if (researchGoesOnline() && !hasWebConsent()) {
            const ok = await uiConfirm({ title: t("research.consent.title"), message: t("research.consent.body"), okLabel: t("research.consent.ok") });
            if (!ok) return;
            grantWebConsent();
          }
          const result = await cancellable((signal) => runResearch({ question: question.trim(), signal, onProgress: (m) => showAiToast(m, "info") }));
          openTemplateDoc(`Research — ${question.trim().slice(0, 60).replace(/[\\/:*?"<>|]+/g, " ")}`, result.markdown);
          showAiToast(t("research.done", { sources: result.sources }), "success");
          if (result.unverified) showAiToast(t("research.unverified", { count: result.unverified }), "error");
        } catch (e) {
          if (isAbort(e)) return;
          showAiToast(t("research.failed", { message: explainError(e) }), "error");
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, "research.ask")) return;
        }
      },
    },
    {
      id: "clip.url",
      label: t("cmd.clip.url"),
      hint: t("cmd.clip.url.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./researchActions").then((m) => m.clipUrl()),
    },
    {
      id: "clip.clipboard",
      label: t("cmd.clip.clipboard"),
      hint: t("cmd.clip.clipboard.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./researchActions").then((m) => m.clipClipboard()),
    },
    {
      id: "research.verify",
      label: t("cmd.research.verify"),
      hint: t("cmd.research.verify.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: () => import("./researchActions").then((m) => m.researchVerify({ liveDoc })),
    },
    {
      id: "research.settings",
      label: t("cmd.research.settings"),
      hint: t("cmd.research.settings.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: () => import("./researchActions").then((m) => m.researchSettings()),
    },
  ];
}
