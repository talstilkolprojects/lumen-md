/**
 * Import exported chats into the vault (plan W5.7), on this device only:
 * WhatsApp (.txt, or the .zip with its media) and Telegram Desktop
 * (result.json, alone or zipped with its folders). Each chat becomes a
 * folder under Imported/ with one note per day (or one note) and a media/
 * folder; nothing existing is overwritten, and the report counts every
 * message so none is lost silently.
 */
import { parseTelegram, looksLikeTelegram } from "./telegram";
import { parseWhatsApp, looksLikeWhatsApp } from "./whatsapp";
import { renderChat, safeName, type ChatNote, type Grouping, type RenderStrings } from "./notes";
import type { ParsedChat } from "./types";

export interface InputFile {
  /** Path as picked or inside the zip ("photos/photo_1.jpg"). */
  name: string;
  bytes: Uint8Array;
}

export interface ReadChats {
  chats: ParsedChat[];
  /** Every non-chat file, by its path and by its base name. */
  media: Map<string, Uint8Array>;
}

const base = (p: string) => p.replace(/^.*[\\/]/, "");
const isZip = (f: InputFile) => /\.zip$/i.test(f.name) || (f.bytes[0] === 0x50 && f.bytes[1] === 0x4b && f.bytes[2] === 0x03 && f.bytes[3] === 0x04);

/** Read the picked files (zips opened) into chats and their media. */
export async function readChatFiles(files: InputFile[], unzip: (b: ArrayBuffer) => Promise<Map<string, Uint8Array>>): Promise<ReadChats> {
  const chats: ParsedChat[] = [];
  const media = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  const visit = async (f: InputFile, zipName: string | null) => {
    if (isZip(f) && zipName === null) {
      const entries = await unzip(f.bytes.slice().buffer as ArrayBuffer);
      for (const [name, bytes] of entries) if (!/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(name)) await visit({ name, bytes }, f.name);
      return;
    }
    if (/\.json$/i.test(f.name)) {
      try {
        const json = JSON.parse(dec.decode(f.bytes));
        if (looksLikeTelegram(json)) {
          chats.push(...parseTelegram(json, (zipName ?? f.name).replace(/\.(zip|json)$/i, "")));
          return;
        }
      } catch {
        /* why: not JSON — kept as a file */
      }
    }
    if (/\.txt$/i.test(f.name)) {
      const text = dec.decode(f.bytes);
      if (looksLikeWhatsApp(text)) {
        // iPhone exports call the text "_chat.txt": the zip's name carries the chat's.
        chats.push(parseWhatsApp(text, base(f.name) === "_chat.txt" && zipName ? zipName : f.name));
        return;
      }
    }
    media.set(f.name, f.bytes);
    if (!media.has(base(f.name))) media.set(base(f.name), f.bytes);
  };
  for (const f of files) await visit(f, null);
  return { chats, media };
}

export interface PlannedChat {
  folder: string;
  notes: ChatNote[];
  attachments: Array<{ path: string; bytes: Uint8Array }>;
  missing: string[];
  messages: number;
  unreadable: string[];
}

/** Where every note and file of each chat goes (relative paths), without touching the vault. */
export function planChatImport(read: ReadChats, grouping: Grouping, strings: RenderStrings): PlannedChat[] {
  const folders = new Set<string>();
  return read.chats.map((chat) => {
    let folder = safeName(`${chat.name} (${chat.app === "whatsapp" ? "WhatsApp" : "Telegram"})`);
    for (let n = 2; folders.has(folder); n++) folder = safeName(`${chat.name} (${chat.app === "whatsapp" ? "WhatsApp" : "Telegram"}) ${n}`);
    folders.add(folder);
    const attachments = new Map<string, Uint8Array>();
    const missing: string[] = [];
    const mediaPath = (name: string): string | null => {
      const bytes = read.media.get(name) ?? read.media.get(base(name));
      if (!bytes) {
        if (!missing.includes(name)) missing.push(name);
        return null;
      }
      const at = `media/${safeName(base(name))}`;
      attachments.set(at, bytes);
      return at;
    };
    const notes = renderChat(chat, { grouping, mediaPath, strings });
    return { folder, notes, attachments: [...attachments].map(([path, bytes]) => ({ path, bytes })), missing, messages: chat.messages.length, unreadable: chat.unreadable };
  });
}

export interface ChatImportReport {
  folders: string[];
  chats: number;
  messages: number;
  notes: number;
  attachments: number;
  missing: number;
  unreadable: number;
}

export interface VaultWriter {
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  writeText: (path: string, text: string) => Promise<void>;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Plan 2.7: imported chats are someone else's words — agents treat the folder as outside content. */
  markUntrusted: (folder: string) => void;
}

/** Write the planned chats under `Imported/`, each in a free folder name. */
export async function writeChatImport(plan: PlannedChat[], vault: VaultWriter): Promise<ChatImportReport> {
  const report: ChatImportReport = { folders: [], chats: plan.length, messages: 0, notes: 0, attachments: 0, missing: 0, unreadable: 0 };
  for (const c of plan) {
    let folder = `Imported/${c.folder}`;
    for (let n = 2; await vault.exists(folder); n++) folder = `Imported/${c.folder} ${n}`;
    vault.markUntrusted(folder);
    await vault.mkdir(folder);
    for (const a of c.attachments) await vault.writeBytes(`${folder}/${a.path}`, a.bytes);
    for (const n of c.notes) await vault.writeText(`${folder}/${n.path}`, n.content);
    report.folders.push(folder);
    report.messages += c.messages;
    report.notes += c.notes.length;
    report.attachments += c.attachments.length;
    report.missing += c.missing.length;
    report.unreadable += c.unreadable.length;
  }
  return report;
}

/** The app's vault: OPFS through src/storage/workspace. */
export async function appVault(): Promise<VaultWriter> {
  const [ws, { markUntrustedNote }] = await Promise.all([import("../../storage/workspace"), import("../../agents/provenance")]);
  return {
    exists: (p) => ws.workspaceHasEntry(p),
    mkdir: (p) => ws.createWorkspaceFolder(p),
    writeText: (p, t) => ws.writeWorkspaceFile(p, t),
    writeBytes: (p, b) => ws.writeWorkspaceBlob(p, new Blob([b as unknown as BlobPart])),
    markUntrusted: (f) => markUntrustedNote(f, "imported chat"),
  };
}
