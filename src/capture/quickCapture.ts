/**
 * Quick capture (plan 4.16): a line typed into the capture box, or text
 * shared to the installed app, is added to the end of `inbox.md` in the
 * vault as a timestamped list item that links to that day's daily note
 * (plan 4.12):
 *
 *   - [[journal/2026-10-20]] 14:05 call the plumber
 *     a second line stays inside the same item
 *
 * The inbox is created (with a heading) when it is missing; what is already
 * in it is never rewritten — an entry only ever goes after the last byte.
 * When the inbox is open in a tab, its unsaved edits are kept: the entry is
 * added to the open text, not to the older copy on disk. The day's daily
 * note is created too (from its template, never overwritten), so the link
 * opens it.
 *
 * Loaded on demand (the capture box, the share target and the desktop
 * shortcut import it), so none of this is in the startup bundle.
 */

import "./strings";
import { t } from "../i18n";
import { flushPendingEdits, useAppStore } from "../store/useStore";
import { toast } from "../store/useToastStore";
import { readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { dailyPath, dayOf, ensureDailyNote, type DailySettings } from "../daily/dailyNote";
import type { SharedItem } from "../pwa/launch";

/** The inbox note, at the root of the vault. */
export const INBOX_PATH = "inbox.md";

const pad2 = (n: number) => String(n).padStart(2, "0");

// Wiki-link syntax has no escapes: `#` starts a heading, `|` an alias, `[` / `]` end the link.
const WIKI_UNSAFE = /[#|[\]]/;

/**
 * The day's daily note as a wiki link, by its full path (folder too), so a
 * note elsewhere with the same name can't take the link. Wiki links can't
 * escape a path with `#`, `|`, `[` or `]` in it, and the file name alone
 * could open another note with that name: then the entry carries the plain
 * date instead (review: #268).
 */
export function dailyLink(when: Date, daily: Pick<DailySettings, "folder" | "pattern">): string {
  const note = dailyPath(dayOf(when), daily).replace(/\.(md|markdown)$/i, "");
  if (!WIKI_UNSAFE.test(note)) return `[[${note}]]`;
  const d = dayOf(when);
  return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
}

/**
 * One capture as a Markdown list item: the day's daily note as a wiki link,
 * the local time, then the text. Further lines are indented so they stay in
 * the item. The text itself is kept as typed (Hebrew, emoji, bidi marks);
 * only blank lines around it and trailing spaces are dropped. Null when
 * there is nothing to capture.
 */
export function formatEntry(text: string, when: Date, daily: Pick<DailySettings, "folder" | "pattern">): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  const [first, ...rest] = lines;
  const head = `- ${dailyLink(when, daily)} ${pad2(when.getHours())}:${pad2(when.getMinutes())} ${first.trimStart()}`;
  return [head, ...rest.map((l) => (l.trim() ? `  ${l}` : ""))].join("\n");
}

/**
 * The inbox with `entry` added at the end. `existing` null = there is no
 * inbox yet: it starts with a heading. Existing text is kept byte for byte;
 * at most a newline is added after it, so the entry starts on its own line.
 */
export function appendEntry(existing: string | null, entry: string, heading: string = t("capture.inboxHeading")): string {
  if (existing === null) return `# ${heading}\n\n${entry}\n`;
  if (!existing) return `${entry}\n`;
  return `${existing}${existing.endsWith("\n") ? "" : "\n"}${entry}\n`;
}

/** The text of a shared item (share target): title and link, then the text. */
export function sharedText(item: SharedItem): string {
  const head = [item.title, item.link ? `<${item.link}>` : ""].filter(Boolean).join(" ");
  return [head, item.text].filter(Boolean).join("\n");
}

// Captures run one after another: two at once must not both read the old
// inbox and the second write drop the first entry.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Add `text` to the end of the inbox (created if missing). Resolves to the
 * inbox path, or null when the text was empty.
 */
export function captureToInbox(text: string, when: Date = new Date()): Promise<string | null> {
  // Across tabs and windows too (OPFS is shared by the origin): the Web Locks
  // API serialises the read-append-write where it exists (review #268).
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const run = () => (locks ? locks.request("lumen-inbox-capture", () => capture(text, when)) : capture(text, when));
  const job = queue.then(run);
  queue = job.catch(() => undefined);
  return job;
}

async function capture(text: string, when: Date): Promise<string | null> {
  const { dailyNotes, locale } = useAppStore.getState();
  const entry = formatEntry(text, when, dailyNotes);
  if (!entry) return null;
  // Edits the editor has not handed to the store yet belong to the base too.
  flushPendingEdits();
  const s = useAppStore.getState();
  const tab = s.openTabs.find((x) => x.workspaceName === INBOX_PATH);
  const exists = await workspaceHasFile(INBOX_PATH);
  const base = s.doc.workspaceName === INBOX_PATH ? s.doc.content : tab ? tab.content : exists ? await readWorkspaceFile(INBOX_PATH) : null;
  const next = appendEntry(base, entry);
  await writeWorkspaceFile(INBOX_PATH, next);
  // Lumen's own write: the new base for the open copy's compare-and-swap save (plan 4.4).
  await import("../store/externalChanges").then((m) => m.noteOwnWrite(INBOX_PATH, next)).catch(() => undefined);
  // The open copy follows the file. The active inbox stays dirty, so the
  // editor's autosave writes it once more after any older autosave still in
  // flight — that one can't leave the file without the entry. Typed into
  // while we wrote: keep that text and add the entry to it.
  useAppStore.setState((st) => {
    const active = st.doc.workspaceName === INBOX_PATH;
    const typed = active && st.doc.content !== (base ?? "") && st.doc.content !== next;
    const doc = active ? { ...st.doc, content: typed ? appendEntry(st.doc.content, entry) : next, dirty: true } : st.doc;
    // A background inbox tab may have been edited too (the capture began while
    // it was active, then the user typed and switched away): keep that text
    // and add the entry to it. Either way it stays dirty, like the active one:
    // an autosave of the old text may still be in flight and land after this
    // write, and a clean tab would never write the entry again (review #268).
    const openTabs = st.openTabs.map((x) => {
      if (x.workspaceName !== INBOX_PATH) return x;
      if (active) return { ...x, content: doc.content, dirty: true };
      const edited = x.content !== (base ?? "") && x.content !== next;
      return { ...x, content: edited ? appendEntry(x.content, entry) : next, dirty: true };
    });
    return { doc, openTabs };
  });
  notifyWorkspaceChanged(exists ? { kind: "content", paths: [INBOX_PATH] } : { kind: "structure", paths: [INBOX_PATH] });
  // The entry links to the day's note: make sure it is there to open.
  await ensureDailyNote(dayOf(when), dailyNotes, locale).catch(() => undefined);
  return INBOX_PATH;
}

/** Show the inbox: its open tab (with any unsaved edits), or a new tab from disk (created when missing). */
export async function openInbox(): Promise<void> {
  const s = useAppStore.getState();
  if (s.doc.workspaceName === INBOX_PATH) return;
  const tab = s.openTabs.find((x) => x.workspaceName === INBOX_PATH);
  let content = tab?.content;
  if (content === undefined) {
    if (await workspaceHasFile(INBOX_PATH)) content = await readWorkspaceFile(INBOX_PATH);
    else {
      content = `# ${t("capture.inboxHeading")}\n\n`;
      await writeWorkspaceFile(INBOX_PATH, content);
      notifyWorkspaceChanged({ kind: "structure", paths: [INBOX_PATH] });
    }
  }
  s.openTab({ name: INBOX_PATH, content, workspaceName: INBOX_PATH });
  // openTab loads the doc as clean; an open tab with unsaved edits must stay
  // dirty, or switching away would mark them saved and they'd never be written (review #268).
  if (tab?.dirty) useAppStore.setState((st) => (st.doc.workspaceName === INBOX_PATH ? { doc: { ...st.doc, dirty: true } } : {}));
}

/**
 * Something shared to the installed app (Android share sheet, desktop
 * share): added to the inbox, then the inbox is shown. Resolves to the
 * inbox path, or null when nothing was shared.
 */
export async function captureShared(item: SharedItem): Promise<string | null> {
  // A message shared from WhatsApp or Telegram keeps its app, author and time (plan W5.7).
  const chat = !item.link && item.text ? (await import("./chats/share")).chatShareText(item.text) : null;
  const path = await captureToInbox(chat ?? sharedText(item));
  if (path) {
    toast.success(t("capture.saved", { path }));
    await openInbox().catch(() => undefined);
  }
  return path;
}
