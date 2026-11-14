/**
 * Bodies of palette commands that load on use (perf, plan W4.9): the palette
 * lists the commands from the domain file; a body arrives when its command
 * runs, so none of this code is in the startup bundle.
 */
import { uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import { explainError } from "../../lib/userError";
import { openTemplateDoc } from "../openDoc";
import type { CommandContext } from "./context";
import { saveClip } from "./research";

/** `clip.url` (moved from research.ts, which loads this module when the command runs). */
export const clipUrl = async () => {
  const url = await uiPrompt({ message: t("clip.url.prompt"), defaultValue: "https://" });
  if (!url || !/^https?:\/\/\S+$/.test(url.trim())) return;
  try {
    const { clipUrl } = await import("../../research/clipper");
    await saveClip(await clipUrl(url.trim()));
  } catch (e) {
    if ((e as Error)?.name === "ResearchUnavailableError") showAiToast(t("clip.needsService"), "error");
    else showAiToast(t("clip.failed", { message: explainError(e) }), "error");
    if ((e as Error)?.name === "ResearchUnavailableError") showAiToast(t("clip.needsService"), "error");
    else if ((e as Error)?.name === "PrivacyBlockedError") showAiToast(t("clip.localOnly"), "info");
  }
};

/** `clip.clipboard` (moved from research.ts, which loads this module when the command runs). */
export const clipClipboard = async () => {
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
    showAiToast(t("clip.failed", { message: explainError(e) }), "error");
  }
};

/** `research.verify` (moved from research.ts, which loads this module when the command runs). */
export const researchVerify = async ({ liveDoc }: Pick<CommandContext, "liveDoc">) => {
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
};

/** `research.settings` (moved from research.ts, which loads this module when the command runs). */
export const researchSettings = async () => {
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
      /* why: storage denied */
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
};
