/**
 * What the installed app was launched with (D3): the manifest promises a
 * share target, file handlers and shortcuts — this is the code that keeps
 * those promises.
 *
 *  - share_target (GET): `/?title=…&text=…&url=…` → appended to inbox.md
 *    (plan 4.16; `sharedItem`), or a new note with the shared text and link
 *    where the vault can't be written (Android share sheet, desktop share).
 *    A message shared from WhatsApp or Telegram goes through the chat
 *    parser first (`sharedChat`, plan W5.7, audit W10.C10), on both paths:
 *    it keeps its app, author and time.
 *  - shortcuts: `/?action=new` → a new note, `/?action=palette` → ⌘K,
 *    `/?capture=1` → the quick-capture box (plan 4.16).
 *    `/?capture=voice` → the box, already recording a voice note (plan W1.13).
 *  - file_handlers: files opened with the installed app (Chrome / Edge
 *    "Open with Lumen") arrive through `launchQueue` → one tab each.
 */

import { chatShareText, parseSharedChatMessage } from "../capture/chats/share";

export type Launch =
  | { kind: "share"; title: string; body: string }
  | { kind: "action"; action: "new" | "palette" | "capture" | "voice" }
  | { kind: "none" };

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

/** What was shared: its title, its text (without the link) and its link. */
export interface SharedItem {
  title: string;
  text: string;
  link: string;
}

/** The shared item in a share-target URL, or null when nothing was shared. */
export function sharedItem(search: string): SharedItem | null {
  const q = new URLSearchParams(search);
  const title = (q.get("title") ?? "").trim();
  const text = (q.get("text") ?? "").trim();
  const url = (q.get("url") ?? "").trim();
  if (!title && !text && !url) return null;
  // Android puts the link inside `text` and leaves `url` empty.
  const link = url || (/^https?:\/\/\S+$/.test(text) ? text : "");
  return { title, text: link && text === link ? "" : text, link };
}

/**
 * A shared chat message (WhatsApp or Telegram, as their share sheet or
 * "copy" sends it) as the inbox text "WhatsApp · Tal · 2026-11-12 14:03"
 * then the message; null when the share is a link or not a chat message.
 */
export function sharedChat(item: SharedItem): string | null {
  return !item.link && item.text ? chatShareText(item.text) : null;
}

/** Read (and describe) the launch parameters from a URL search string. */
export function parseLaunch(search: string): Launch {
  const q = new URLSearchParams(search);
  const action = q.get("action");
  if (action === "new" || action === "palette" || action === "capture") return { kind: "action", action };
  if (q.get("capture") === "1") return { kind: "action", action: "capture" };
  if (q.get("capture") === "voice") return { kind: "action", action: "voice" };
  const shared = sharedItem(search);
  if (!shared) return { kind: "none" };
  const { title, link, text: rest } = shared;
  // A chat message: the note is named after the app and the author, and keeps the time.
  const chat = !link && rest ? parseSharedChatMessage(rest) : null;
  if (chat) {
    const heading = `${chat.app} · ${chat.author}`;
    return { kind: "share", title: heading, body: [`# ${heading}`, "", sharedChat(shared)!, ""].join("\n") };
  }
  const heading = title || (link ? hostOf(link) : rest.split("\n")[0].slice(0, 60)) || "Shared";
  const parts = [`# ${heading}`, ""];
  if (rest) parts.push(rest, "");
  if (link) parts.push(`<${link}>`, "");
  return { kind: "share", title: heading, body: parts.join("\n") };
}

/** Remove the launch parameters so a reload doesn't repeat them. */
export function clearLaunchParams(): void {
  if (typeof location === "undefined" || !location.search) return;
  const q = new URLSearchParams(location.search);
  for (const k of ["action", "capture", "title", "text", "url"]) q.delete(k);
  const rest = q.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
}

interface LaunchParams {
  files?: FileSystemFileHandle[];
}

/**
 * Files opened with the installed app (Chromium's File Handling API). The
 * handle is passed on, so saving writes back to that file.
 */
export function onLaunchFiles(open: (name: string, content: string, handle: FileSystemFileHandle) => void): void {
  const lq = (window as unknown as { launchQueue?: { setConsumer(fn: (p: LaunchParams) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    for (const h of params.files ?? []) {
      try {
        const f = await h.getFile();
        open(f.name, await f.text(), h);
      } catch {
        /* why: a launched file that cannot be read is skipped; the others still open */
      }
    }
  });
}

/**
 * Desktop app only: the system-wide quick-capture shortcut (plan 4.16),
 * when the shell has Tauri's global-shortcut plugin (a feature check — see
 * src/capture/desktopShortcut.ts). A press opens the capture box.
 */
export function onDesktopCapture(): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void import("../capture/desktopShortcut")
    .then((m) => m.registerGlobalCapture(() => window.dispatchEvent(new CustomEvent("lumen-open-capture"))))
    .catch(() => false);
}
