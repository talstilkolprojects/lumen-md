/**
 * Book-writing mode (plan W5.8) in the palette: "Book: chapters, goals and
 * export" on the book's index note or any of its chapters (or, on a note
 * outside a book, an offer to make the note's folder a book), and "Add this
 * note to the book". Everything, the bodies included (./bookActions.ts), is
 * loaded on first use.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";

const actions = () => import("./bookActions");

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
        // Snapshot before the import: a tab switch while the chunk loads must not open another note's book.
        const doc = liveDoc();
        await (await actions()).openBook(doc);
      },
    },
    {
      id: "book.addChapter",
      label: t("cmd.book.addChapter"),
      hint: t("cmd.book.addChapter.hint"),
      icon: cmdIcons.FileText,
      group,
      action: async () => {
        const path = liveDoc().workspaceName;
        await (await actions()).addNoteToBook(path);
      },
    },
  ];
}
