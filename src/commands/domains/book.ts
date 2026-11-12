/**
 * Book-writing mode (plan W5.8) in the palette: "Book: chapters, goals and
 * export" on the book's index note or any of its chapters (or, on a note
 * outside a book, an offer to make the note's folder a book), and "Add this
 * note to the book". Everything is loaded on first use.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { uiAlert, uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";
import type { CommandContext } from "./context";

const load = async () => {
  const [app, dialog] = await Promise.all([import("../../book/app"), import("../../book/BookDialog")]);
  return { app, dialog };
};

export function buildBookCommands({ liveDoc }: CommandContext): Command[] {
  const group = t("group.view");
  return [
    {
      id: "book.open",
      label: t("cmd.book.open"),
      hint: t("cmd.book.open.hint"),
      icon: cmdIcons.FileText,
      group,
      action: async () => {
        const { app, dialog } = await load();
        const doc = liveDoc();
        const path = doc.workspaceName;
        if (!path) {
          await uiAlert({ message: t("book.none") });
          return;
        }
        try {
          const book = await app.findBook(path, doc.content);
          if (book) {
            dialog.openBookDialog(app, book.path);
            return;
          }
          if (!(await uiConfirm({ message: `${t("book.none")}\n\n${t("book.create")}?` }))) return;
          const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          const title = (await uiPrompt({ message: t("book.create.prompt"), defaultValue: folder.split("/").pop() || t("book.title") }))?.trim();
          if (!title) return;
          const created = await app.createBook(folder, title, document.documentElement.lang || "he");
          useToastStore.getState().push({ kind: "success", title: t("book.created", { path: created }) });
          dialog.openBookDialog(app, created);
        } catch (e) {
          useToastStore.getState().push({ kind: "error", title: t("book.failed", { error: (e as Error).message }) });
        }
      },
    },
    {
      id: "book.addChapter",
      label: t("cmd.book.addChapter"),
      hint: t("cmd.book.addChapter.hint"),
      icon: cmdIcons.FileText,
      group,
      action: async () => {
        const { app, dialog } = await load();
        const path = liveDoc().workspaceName;
        if (!path) return;
        try {
          const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
          const { listWorkspace, readWorkspaceFile } = await import("../../storage/workspace");
          for (const f of await listWorkspace()) {
            if (!f.path.startsWith(folder) || f.path.slice(folder.length).includes("/") || f.path === path || !f.path.endsWith(".md")) continue;
            const text = await readWorkspaceFile(f.path);
            const book = app.parseBookIndex(f.path, text);
            if (!book) continue;
            const name = path.slice(folder.length, -3);
            if (!book.chapters.some((c) => c.path === path)) await app.saveIndex(f.path, app.addChapter(text, name));
            dialog.openBookDialog(app, f.path);
            return;
          }
          await uiAlert({ message: t("book.none") });
        } catch (e) {
          useToastStore.getState().push({ kind: "error", title: t("book.failed", { error: (e as Error).message }) });
        }
      },
    },
  ];
}
