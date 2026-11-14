/** Research agent, web clipper and citation check. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, getLocale } from "../../i18n";
import { uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { isAbort } from "../../ai/aiAbort";
import { openTemplateDoc } from "../openDoc";
import { cancellable, type CommandContext } from "./context";

/** Save a clip into the library folder and open it (T34). Exported for tests. */
export async function saveClip(clip: { title: string; markdown: string }): Promise<void> {
  const { clipFileName, libraryDir } = await import("../../research/clipper");
  const { writeWorkspaceFile, workspaceHasEntry, isOPFSAvailable } = await import("../../storage/workspace");
  const name = clipFileName(clip.title);
  if (!isOPFSAvailable()) {
    // Nothing was written: open it as an unsaved (dirty) document in its own
    // tab, so closing the tab or the page warns instead of losing the clip.
    openTemplateDoc(name.replace(/\.md$/, ""), clip.markdown);
    return;
  }
  const dir = libraryDir(getLocale());
  let path = `${dir}/${name}`;
  for (let i = 2; await workspaceHasEntry(path); i++) path = `${dir}/${name.replace(/\.md$/, "")} (${i}).md`;
  await writeWorkspaceFile(path, clip.markdown);
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  useAppStore.getState().openTab({ name: path.split("/").pop()!, content: clip.markdown, workspaceName: path });
  showAiToast(t("clip.saved", { path }), "success");
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
          showAiToast(t("research.failed", { message: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "clip.url",
      label: t("cmd.clip.url"),
      hint: t("cmd.clip.url.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const url = await uiPrompt({ message: t("clip.url.prompt"), defaultValue: "https://" });
        if (!url || !/^https?:\/\/\S+$/.test(url.trim())) return;
        try {
          const { clipUrl } = await import("../../research/clipper");
          await saveClip(await clipUrl(url.trim()));
        } catch (e) {
          if ((e as Error)?.name === "ResearchUnavailableError") showAiToast(t("clip.needsService"), "error");
          else showAiToast(t("clip.failed", { message: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "clip.clipboard",
      label: t("cmd.clip.clipboard"),
      hint: t("cmd.clip.clipboard.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        try {
          const { clipFromHtml } = await import("../../research/clipper");
          let html = "";
          let text = "";
          for (const item of await navigator.clipboard.read()) {
            if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
            else if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
          }
          if (!html && !text) {
            showAiToast(t("clip.empty"), "info");
            return;
          }
          const source = (await uiPrompt({ message: t("clip.source.prompt"), defaultValue: "https://" }))?.trim() || t("clip.source.unknown");
          await saveClip(clipFromHtml(html || `<pre>${text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`, source));
        } catch (e) {
          showAiToast(t("clip.failed", { message: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "research.verify",
      label: t("cmd.research.verify"),
      hint: t("cmd.research.verify.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: async () => {
        const { parseCitations, verifyCitations, formatCitationReport } = await import("../../research/citations");
        const { extractPage, researchEndpoint } = await import("../../research/client");
        const citations = parseCitations(liveDoc().content);
        if (!citations.length) {
          showAiToast(t("research.noCitations"), "info");
          return;
        }
        if (!researchEndpoint()) {
          showAiToast(t("research.noService"), "error");
          return;
        }
        const checks = await verifyCitations(citations, (u) => extractPage(u), {
          onProgress: (done, total) => {
            if (done === total || done % 5 === 0) showAiToast(t("research.checking", { done, total }), "info");
          },
        });
        // A tab name, not a path: the note's base name only.
        const base = (liveDoc().name.split("/").pop() ?? liveDoc().name).replace(/\.(md|markdown)$/i, "");
        openTemplateDoc(`Citation check — ${base}`, formatCitationReport(base, checks));
      },
    },
    {
      id: "research.settings",
      label: t("cmd.research.settings"),
      hint: t("cmd.research.settings.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: async () => {
        const { getResearchSettings, setResearchSettings, researchEndpoint } = await import("../../research/client");
        const cur = getResearchSettings();
        const choice = await uiSelect({
          title: t("cmd.research.settings"),
          message: t("cmd.research.settings.hint"),
          defaultValue: cur.provider,
          choices: [
            { value: "claude", label: t("research.provider.claude") },
            { value: "brave", label: t("research.provider.brave") },
            { value: "tavily", label: t("research.provider.tavily") },
            { value: "searxng", label: t("research.provider.searxng") },
          ],
        });
        if (choice !== "claude" && choice !== "brave" && choice !== "tavily" && choice !== "searxng") return;
        if (choice === "searxng") {
          // Keyless: the research service on this machine queries a local SearXNG.
          const endpoint = await uiPrompt({ message: t("research.endpoint"), defaultValue: researchEndpoint() ?? "http://localhost:8787" });
          if (endpoint === null || !endpoint.trim()) return;
          // Checked before it is stored: a bad override would hide a
          // working build-time endpoint.
          const { usableResearchEndpoint } = await import("../../research/client");
          const usable = usableResearchEndpoint(endpoint);
          if (!usable) {
            showAiToast(t("research.endpointInvalid", { url: endpoint.trim() }), "error");
            return;
          }
          try {
            localStorage.setItem("lumen.research.endpoint", usable);
          } catch {
            /* storage denied */
          }
          setResearchSettings({ provider: "searxng" });
        } else if (choice !== "claude") {
          // Brave / Tavily go through the research service: without it the
          // choice can't work, so keep the current setting.
          if (!researchEndpoint()) {
            showAiToast(t("research.noService"), "error");
            return;
          }
          const key = await uiPrompt({ message: t("research.key", { provider: choice === "brave" ? "Brave Search" : "Tavily" }), defaultValue: cur.provider === choice ? cur.key : "" });
          // Cancelled (or no key): keep the previous provider and key.
          if (key === null || !key.trim()) return;
          setResearchSettings({ provider: choice, key: key.trim() });
        } else setResearchSettings({ provider: choice });
        showAiToast(t(`research.provider.${choice}`), "success");
      },
    },
  ];
}
