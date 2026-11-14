/**
 * Import mail and Google Takeout into the vault (plan W5.18), from files
 * only: .eml, .mbox (Gmail's Takeout, Thunderbird, Apple Mail) and a
 * Takeout .zip with Keep and Drive. One note per thread with its
 * attachments; Keep notes as notes; Docs converted to Markdown. Written with
 * the same writer as the chat import (../chats/importChats): new folders
 * under Imported/, nothing overwritten, marked as outside content.
 */
import { parseMail, type MailMessage } from "./mime";
import { looksLikeMbox, splitMbox } from "./mbox";
import { groupThreads, renderThread } from "./threads";
import { DOC_EXT, isDriveFile, isKeepJson, keepNoteMarkdown, readKeep, type KeepNote } from "./takeout";
import { safeName } from "../chats/notes";
import type { InputFile, PlannedChat } from "../chats/importChats";

export interface ReadMail {
  messages: MailMessage[];
  keep: KeepNote[];
  docs: InputFile[];
  /** Every other file, by path and by base name (Keep attachments, Drive files). */
  files: Map<string, Uint8Array>;
  drive: InputFile[];
  /** Messages that could not be parsed at all. */
  unreadable: string[];
}

const base = (p: string) => p.replace(/^.*[\\/]/, "");
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export async function readMailFiles(files: InputFile[], unzip: (b: ArrayBuffer) => Promise<Map<string, Uint8Array>>): Promise<ReadMail> {
  const out: ReadMail = { messages: [], keep: [], docs: [], files: new Map(), drive: [], unreadable: [] };
  const dec = new TextDecoder();
  const visit = async (f: InputFile, inZip: boolean) => {
    if (!inZip && (/\.zip$/i.test(f.name) || isZip(f.bytes))) {
      for (const [name, bytes] of await unzip(f.bytes.slice().buffer as ArrayBuffer)) if (!/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(name)) await visit({ name, bytes }, true);
      return;
    }
    if (/\.mbox$/i.test(f.name) || (!/\.(eml|json|html?|txt)$/i.test(f.name) && looksLikeMbox(f.bytes))) {
      for (const [i, m] of splitMbox(f.bytes).entries()) {
        try {
          out.messages.push(parseMail(m));
        } catch (e) {
          out.unreadable.push(`${f.name} #${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }
    if (/\.eml$/i.test(f.name)) {
      try {
        out.messages.push(parseMail(f.bytes));
      } catch (e) {
        out.unreadable.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (/\.json$/i.test(f.name) && /(^|\/)Keep\//i.test(f.name)) {
      try {
        const json = JSON.parse(dec.decode(f.bytes));
        if (isKeepJson(f.name, json)) {
          out.keep.push(readKeep(json));
          return;
        }
      } catch {
        /* why: not a Keep note — kept as a file */
      }
    }
    if (/(^|\/)Keep\//i.test(f.name) && /\.html$/i.test(f.name)) return; // Keep's HTML twin of each JSON note
    if (isDriveFile(f.name)) {
      if (DOC_EXT.test(f.name)) out.docs.push(f);
      else out.drive.push(f);
      return;
    }
    out.files.set(f.name, f.bytes);
    if (!out.files.has(base(f.name))) out.files.set(base(f.name), f.bytes);
  };
  for (const f of files) await visit(f, false);
  return out;
}

/** Gmail labels and how many messages carry each, most used first. */
export function labelCounts(messages: MailMessage[]): Array<{ label: string; n: number }> {
  const c = new Map<string, number>();
  for (const m of messages) for (const l of m.labels) c.set(l, (c.get(l) ?? 0) + 1);
  return [...c].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

export interface MailPlanOptions {
  /** Only messages with this Gmail label (null: all). */
  label: string | null;
  htmlToMarkdown: (html: string) => string;
  /** A Drive document → Markdown, or null when it can't be read (then it is copied as a file). */
  docToMarkdown: (f: InputFile) => Promise<string | null>;
  formatDate: (d: Date) => string;
  noSubject: string;
  missing: string;
  /** Leave Keep notes that are in Keep's trash out (counted in the report). */
  skipTrashed: boolean;
}

function uniquePath(taken: Set<string>, path: string): string {
  const ext = path.match(/\.[^./]+$/)?.[0] ?? "";
  const stem = path.slice(0, path.length - ext.length);
  let p = path;
  for (let n = 2; taken.has(p.toLowerCase()); n++) p = `${stem} ${n}${ext}`;
  taken.add(p.toLowerCase());
  return p;
}

/** Folders to write: "Mail", "Google Keep", "Google Docs" (same shape as the chat import, so the same writer). */
export async function planMailImport(read: ReadMail, o: MailPlanOptions): Promise<{ folders: PlannedChat[]; threads: number; trashed: number }> {
  const folders: PlannedChat[] = [];
  const messages = o.label ? read.messages.filter((m) => m.labels.includes(o.label as string)) : read.messages;
  let threads = 0;
  if (messages.length) {
    const taken = new Set<string>();
    const attachments: Array<{ path: string; bytes: Uint8Array }> = [];
    const where = new Map<MailMessage, string[]>();
    for (const m of messages) {
      where.set(
        m,
        m.attachments.map((a) => {
          const p = uniquePath(taken, `attachments/${safeName(a.name)}`);
          attachments.push({ path: p, bytes: a.bytes });
          return p;
        }),
      );
    }
    const noteNames = new Set<string>();
    const groups = groupThreads(messages);
    threads = groups.length;
    const notes = groups.map((t) => {
      const n = renderThread(t, { htmlToMarkdown: o.htmlToMarkdown, attachmentPath: (m, i) => where.get(m)?.[i] ?? "", noSubject: o.noSubject, formatDate: o.formatDate });
      return { ...n, path: uniquePath(noteNames, n.path) };
    });
    folders.push({ folder: o.label ? safeName(`Mail - ${o.label}`) : "Mail", notes, attachments, missing: [], messages: messages.length, unreadable: read.unreadable });
  }
  let trashed = 0;
  if (read.keep.length) {
    const taken = new Set<string>();
    const names = new Set<string>();
    const attachments: Array<{ path: string; bytes: Uint8Array }> = [];
    const missing: string[] = [];
    const notes = [];
    for (const k of read.keep) {
      if (k.trashed && o.skipTrashed) {
        trashed++;
        continue;
      }
      const md = keepNoteMarkdown(
        k,
        (p) => {
          const bytes = read.files.get(p) ?? read.files.get(base(p)) ?? [...read.files].find(([name]) => name.endsWith(`/Keep/${base(p)}`))?.[1];
          if (!bytes) {
            missing.push(p);
            return null;
          }
          const at = uniquePath(taken, `attachments/${safeName(base(p))}`);
          attachments.push({ path: at, bytes });
          return at;
        },
        o.missing,
      );
      notes.push({ path: uniquePath(names, `${md.name}.md`), content: md.content, messages: 1 });
    }
    if (notes.length) folders.push({ folder: "Google Keep", notes, attachments, missing, messages: 0, unreadable: [] });
  }
  if (read.docs.length || read.drive.length) {
    const names = new Set<string>();
    const notes = [];
    const attachments: Array<{ path: string; bytes: Uint8Array }> = [];
    const files = new Set<string>();
    const rel = (p: string) => p.replace(/^.*?(?:^|\/)(?:Drive|Google Drive|Google Docs)\//i, "");
    for (const d of read.docs) {
      const md = await o.docToMarkdown(d).catch(() => null);
      if (md === null) {
        attachments.push({ path: uniquePath(files, safeRel(rel(d.name))), bytes: d.bytes });
        continue;
      }
      const stem = safeRel(rel(d.name)).replace(DOC_EXT, "");
      notes.push({ path: uniquePath(names, `${stem}.md`), content: md.endsWith("\n") ? md : `${md}\n`, messages: 0 });
    }
    for (const f of read.drive) attachments.push({ path: uniquePath(files, safeRel(rel(f.name))), bytes: f.bytes });
    folders.push({ folder: "Google Docs", notes, attachments, missing: [], messages: 0, unreadable: [] });
  }
  return { folders, threads, trashed };
}

/** A relative path with every segment made safe. */
function safeRel(p: string): string {
  return p
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => {
      const ext = s.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
      return safeName(s.slice(0, s.length - ext.length)) + ext;
    })
    .join("/");
}
