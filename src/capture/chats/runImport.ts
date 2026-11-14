/**
 * The "Import a WhatsApp or Telegram chat…" command (plan W5.7): pick the
 * export (any mix of .txt, .zip, .json and media files), choose one note per
 * day or one per chat, and the chats land in Imported/. Everything happens
 * on this device: the files are read here and nothing is sent anywhere.
 */
import "./strings";
import { t } from "../../i18n";
import { uiSelect } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { appVault, planChatImport, readChatFiles, writeChatImport, type InputFile } from "./importChats";
import type { Grouping, RenderStrings } from "./notes";

export function renderStrings(): RenderStrings {
  return {
    missing: t("chatImport.missing"),
    omitted: t("chatImport.omitted"),
    forwarded: (name) => t("chatImport.forwarded", { name }),
    reply: (id) => t("chatImport.reply", { id }),
  };
}

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".txt,.zip,.json,text/plain,application/zip,application/json,image/*,video/*,audio/*,application/pdf,.opus,.vcf";
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function runChatImport(): Promise<void> {
  const files = await pickFiles();
  if (!files.length) return;
  const grouping = (await uiSelect({
    message: t("chatImport.grouping"),
    choices: [
      { value: "day", label: t("chatImport.byDay") },
      { value: "chat", label: t("chatImport.byChat") },
    ],
  })) as Grouping | null;
  if (!grouping) return;
  try {
    const [{ unzip }] = await Promise.all([import("../../storage/zip")]);
    const input: InputFile[] = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const read = await readChatFiles(input, (b) => unzip(b));
    if (!read.chats.length) {
      showAiToast(t("chatImport.none"), "error");
      return;
    }
    const report = await writeChatImport(planChatImport(read, grouping, renderStrings()), await appVault());
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    showAiToast(t("chatImport.done", { chats: report.chats, messages: report.messages, notes: report.notes, files: report.attachments, folder: report.folders.join(", ") }), "info");
    if (report.missing) showAiToast(t("chatImport.missingSome", { n: report.missing }), "info");
  } catch (e) {
    showAiToast(t("chatImport.failed", { error: e instanceof Error ? e.message : String(e) }), "error");
  }
}
