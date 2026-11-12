/**
 * "Note password…" (plan W5.11, part 3): lock the open note with a password
 * of its own, open a locked note, lock it again, change or remove the
 * password. Loaded on first use; the crypto is in storage/lockedNote.ts.
 */
import "../lib/journalistStrings";
import { t } from "../i18n";
import { explainError } from "../lib/userError";
import { useAppStore } from "../store/useStore";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { clearHistory, historyKey } from "../storage/history";
import { lockedNotes } from "../storage/lockedNotesRegistry";
import {
  allowPlainWrite,
  forgetOpen,
  isOpenLocked,
  isSealedNote,
  lockNote,
  MIN_NOTE_PASSWORD,
  rememberOpen,
  unlockNote,
  WrongNotePasswordError,
} from "../storage/lockedNote";
import { uiAlert, uiConfirm, uiPrompt, uiSelect } from "./PromptDialog";

const readCurrent = (path: string) => readWorkspaceFile(path).catch(() => null);

/** Show `content` as the open note's text, as if it had just been loaded. */
function showText(content: string): void {
  const { doc, setDoc } = useAppStore.getState();
  setDoc({ name: doc.name, content, dirty: false });
}

async function askNewPassword(): Promise<string | null> {
  for (;;) {
    const first = await uiPrompt({ title: t("notePw.newTitle"), message: t("notePw.newMessage", { n: MIN_NOTE_PASSWORD }), password: true });
    if (first === null) return null;
    if (first.length < MIN_NOTE_PASSWORD) {
      await uiAlert({ message: t("notePw.tooShort", { n: MIN_NOTE_PASSWORD }) });
      continue;
    }
    const again = await uiPrompt({ title: t("notePw.newTitle"), message: t("notePw.repeat"), password: true });
    if (again === null) return null;
    if (again === first) return first;
    await uiAlert({ message: t("notePw.mismatch") });
  }
}

// The external-changes watcher is itself loaded on demand (its strings are lazy): reached the same way here.
const ownWrite = async () => (await import("../store/externalChanges")).noteOwnWrite;

/** Seal and write the open note's text under its (new or kept) key. */
async function writeSealed(path: string, plain: string): Promise<void> {
  await writeWorkspaceFile(path, plain);
  (await ownWrite())(path, lockedNotes.sealed(path) ?? plain);
}

export async function notePasswordFlow(): Promise<void> {
  const { doc } = useAppStore.getState();
  const path = doc.workspaceName;
  if (!path) {
    await uiAlert({ message: t("notePw.needsVault") });
    return;
  }

  // A locked note that is not open: ask for its password.
  const onDisk = await readCurrent(path);
  if (!isOpenLocked(path) && ((onDisk !== null && isSealedNote(onDisk)) || isSealedNote(doc.content))) {
    const sealed = onDisk !== null && isSealedNote(onDisk) ? onDisk : doc.content;
    const pw = await uiPrompt({ title: t("notePw.unlockTitle"), message: t("notePw.unlockMessage"), password: true });
    if (pw === null) return;
    try {
      const { plain, key } = await unlockNote(sealed, pw);
      rememberOpen(path, key, sealed, readCurrent);
      showText(plain);
    } catch (e) {
      await uiAlert({ message: e instanceof WrongNotePasswordError ? t("notePw.wrong") : t("notePw.failed", { error: explainError(e) }) });
    }
    return;
  }

  // An open locked note: lock now, change or remove the password.
  if (isOpenLocked(path)) {
    const choice = await uiSelect({
      title: t("notePw.title"),
      message: t("notePw.openMessage"),
      choices: [
        { value: "lock", label: t("notePw.lockNow") },
        { value: "change", label: t("notePw.change") },
        { value: "remove", label: t("notePw.remove") },
      ],
    });
    const plain = useAppStore.getState().doc.content;
    if (choice === "lock") {
      await writeSealed(path, plain);
      const sealed = lockedNotes.sealed(path) ?? plain;
      forgetOpen(path);
      showText(sealed);
    } else if (choice === "change") {
      const pw = await askNewPassword();
      if (pw === null) return;
      const { sealed, key } = await lockNote(plain, pw);
      rememberOpen(path, key, sealed, readCurrent);
      await writeSealed(path, plain);
    } else if (choice === "remove") {
      if (!(await uiConfirm({ title: t("notePw.title"), message: t("notePw.removeConfirm") }))) return;
      allowPlainWrite(path);
      await writeWorkspaceFile(path, plain);
      (await ownWrite())(path, plain);
    }
    return;
  }

  // A plain note: lock it.
  if (!(await uiConfirm({ title: t("notePw.title"), message: t("notePw.lockWarning") }))) return;
  const pw = await askNewPassword();
  if (pw === null) return;
  const plain = useAppStore.getState().doc.content;
  const { sealed, key } = await lockNote(plain, pw);
  rememberOpen(path, key, sealed, readCurrent);
  await writeSealed(path, plain);
  // Earlier versions of the note were plain text: they go, as the warning said.
  await clearHistory(historyKey({ workspaceName: path, name: doc.name })).catch(() => undefined);
  await uiAlert({ message: t("notePw.locked") });
}
