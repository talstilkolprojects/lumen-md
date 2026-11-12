/**
 * The bodies of the book commands (plan W5.8), loaded on first use so the
 * palette's startup list carries only their names (./book.ts).
 */
import { t } from "../../i18n";
import "../../book/bookStrings";
import { uiAlert, uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";

const load = async () => {
  const [app, dialog] = await Promise.all([import("../../book/app"), import("../../book/BookDialog")]);
  return { app, dialog };
};
const failed = (e: unknown) => useToastStore.getState().push({ kind: "error", title: t("book.failed", { error: (e as Error).message }) });

/** The book of the open note (its index or one of its chapters), or an offer to make its folder a book. */
export async function openBook(doc: { workspaceName?: string | null; content: string }): Promise<void> {
  const { app, dialog } = await load();
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
    failed(e);
  }
}

/** Add the open note to the book whose index sits in its folder. */
export async function addNoteToBook(path: string | null | undefined): Promise<void> {
  const { app, dialog } = await load();
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
    failed(e);
  }
}
