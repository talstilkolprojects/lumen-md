/**
 * The "Import mail (.eml, .mbox) or Google Takeout…" command (plan W5.18):
 * files only — no account is connected and nothing leaves the device. Pick
 * .eml / .mbox files or a Takeout .zip; with Gmail labels in the mailbox,
 * choose one or all; threads, Keep notes and Docs land in Imported/.
 */
import "./strings";
import { getLocale, t } from "../../i18n";
import { uiSelect } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { appVault, writeChatImport, type InputFile } from "../chats/importChats";
import { labelCounts, planMailImport, readMailFiles } from "./importMail";

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".eml,.mbox,.zip,message/rfc822,application/mbox,application/zip";
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function runMailImport(): Promise<void> {
  const files = await pickFiles();
  if (!files.length) return;
  try {
    const [{ unzip }, formats] = await Promise.all([import("../../storage/zip"), import("../../storage/fileFormats")]);
    const input: InputFile[] = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const read = await readMailFiles(input, (b) => unzip(b));
    if (!read.messages.length && !read.keep.length && !read.docs.length && !read.drive.length) {
      showAiToast(t("mailImport.none"), "error");
      return;
    }
    let label: string | null = null;
    const labels = labelCounts(read.messages);
    if (labels.length > 1) {
      const num = new Intl.NumberFormat(getLocale());
      const choice = await uiSelect({
        message: t("mailImport.label"),
        choices: [{ value: "", label: t("mailImport.allLabels", { n: read.messages.length }) }, ...labels.map((l) => ({ value: l.label, label: `${l.label} (${num.format(l.n)})` }))],
      });
      if (choice === null) return;
      label = choice || null;
    }
    const fmt = new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" });
    const plan = await planMailImport(read, {
      label,
      htmlToMarkdown: formats.htmlToMarkdown,
      docToMarkdown: async (f) => (await formats.fileToMarkdown(new File([f.bytes as unknown as BlobPart], f.name.split("/").pop() ?? f.name))).content,
      formatDate: (d) => fmt.format(d),
      noSubject: t("mailImport.noSubject"),
      missing: t("mailImport.missing"),
      skipTrashed: true,
    });
    const report = await writeChatImport(plan.folders, await appVault());
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    const keep = plan.folders.find((f) => f.folder === "Google Keep")?.notes.length ?? 0;
    const docs = plan.folders.find((f) => f.folder === "Google Docs")?.notes.length ?? 0;
    showAiToast(t("mailImport.done", { messages: report.messages, threads: plan.threads, keep, docs, files: report.attachments, folders: report.folders.join(", ") }), "info");
    if (plan.trashed) showAiToast(t("mailImport.trashSkipped", { n: plan.trashed }), "info");
  } catch (e) {
    showAiToast(t("mailImport.failed", { error: e instanceof Error ? e.message : String(e) }), "error");
  }
}
