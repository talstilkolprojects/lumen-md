/**
 * A parsed chat → Markdown notes (plan W5.7): one note per day (default) or
 * one for the whole chat, with frontmatter (source, chat, date,
 * participants, message count), every message in order with its time and
 * author, and its media as links to the files copied next to the notes.
 * Nothing is dropped: a message with no text and no media still gets its
 * line, and media the export left out are named as missing.
 */
import { clock, isoDay, type ChatMessage, type ParsedChat } from "./types";

export type Grouping = "day" | "chat";

export interface ChatNote {
  /** Relative to the import folder. */
  path: string;
  content: string;
  messages: number;
}

export interface RenderStrings {
  /** "(not in the export)" after a missing file name. */
  missing: string;
  /** The line for media the export left out. */
  omitted: string;
  /** "forwarded from {name}". */
  forwarded: (name: string) => string;
  /** "in reply to #{id}". */
  reply: (id: number) => string;
}

export interface RenderOptions {
  grouping: Grouping;
  /** The vault-relative name of an attachment as copied (in "media/"), or null when the export does not have it. */
  mediaPath: (name: string) => string | null;
  strings: RenderStrings;
}

const IMAGE = /\.(jpe?g|png|gif|webp|heic|avif|bmp)$/i;

/** A file name safe as a note or folder name in every OS. */
export function safeName(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "_")
      .slice(0, 80) || "chat"
  );
}

/** WhatsApp's own marks (*bold*, _italic_, ~strike~) as Markdown; lines that would start a Markdown block are escaped. */
export function whatsappMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // A Hebrew one-letter prefix (ו, ה, ב, כ, ל, מ, ש) may be glued to the mark: ו_פיתות_.
      let l = line
        .replace(/(^|[\s(והבכלמש])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:;])/g, "$1**$2**")
        .replace(/(^|[\s(והבכלמש])_(\S(?:[^_\n]*\S)?)_(?=$|[\s).,!?:;])/g, "$1*$2*")
        .replace(/(^|[\s(והבכלמש])~(\S(?:[^~\n]*\S)?)~(?=$|[\s).,!?:;])/g, "$1~~$2~~");
      if (/^\s*([#>+|]|[-*]\s|\d+[.)]\s|```|~~~|={3,}|-{3,})/.test(l)) l = "\\" + l.trimStart();
      return l;
    })
    .join("\n");
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function mediaLine(name: string, opts: RenderOptions): string {
  const at = opts.mediaPath(name);
  if (!at) return `📎 ${name} ${opts.strings.missing}`;
  const label = name.replace(/[[\]]/g, "");
  return IMAGE.test(name) ? `![${label}](${enc(at)})` : `📎 [${label}](${enc(at)})`;
}

function messageBlock(chat: ParsedChat, m: ChatMessage, opts: RenderOptions, withDay: boolean): string {
  const when = withDay ? `${isoDay(m.time)} ${clock(m.time)}` : clock(m.time);
  const body = chat.app === "whatsapp" ? whatsappMarkdown(m.text) : m.text;
  const parts: string[] = [];
  if (m.forwardedFrom) parts.push(`↪ ${opts.strings.forwarded(m.forwardedFrom)}`);
  if (m.replyTo) parts.push(`↩ ${opts.strings.reply(m.replyTo)}`);
  if (body) parts.push(body);
  for (const f of m.media) parts.push(mediaLine(f, opts));
  if (m.omitted) parts.push(opts.strings.omitted);
  const lines = parts.join("\n").split("\n");
  const anchor = m.id !== undefined ? ` ^m${m.id}` : "";
  if (m.author === null) {
    // A system line: in italics, after its time.
    return `*${when}* · ${lines.map((l) => l.trim()).join(" ")}${anchor}`;
  }
  const head = `**${when} ${m.author.replace(/\*/g, "\\*")}:**`;
  while (lines.length > 1 && !lines[0].trim()) lines.shift();
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  const [first = "", ...rest] = lines;
  // Inside the message's paragraph a line ends with two spaces (a line
  // break); inside a code fence it stays as it is.
  let fenced = /^\s*(```|~~~)/.test(first);
  const out = [first.startsWith("```") ? head : `${head} ${first}`.trimEnd()];
  if (first.startsWith("```")) out.push(first);
  for (const l of rest) {
    const prev = out.length - 1;
    if (!fenced && !/^\s*(```|~~~)/.test(out[prev])) out[prev] += "  ";
    out.push(l);
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
  }
  // A block id after a closing fence would break the fence: it goes on its own line.
  return out.join("\n") + (anchor && /^\s*(```|~~~)/.test(out[out.length - 1]) ? `\n${anchor.trim()}` : anchor);
}

function frontmatter(fields: Record<string, string | number | string[]>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : typeof v === "number" ? v : JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

const participants = (ms: ChatMessage[]) => [...new Set(ms.map((m) => m.author).filter((a): a is string => !!a))];

export function renderChat(chat: ParsedChat, opts: RenderOptions): ChatNote[] {
  const name = safeName(chat.name);
  if (opts.grouping === "chat") {
    const days = new Map<string, ChatMessage[]>();
    for (const m of chat.messages) days.set(isoDay(m.time), [...(days.get(isoDay(m.time)) ?? []), m]);
    const body = [...days].map(([day, ms]) => `## ${day}\n\n${ms.map((m) => messageBlock(chat, m, opts, false)).join("\n\n")}`).join("\n\n");
    const first = chat.messages[0];
    const last = chat.messages[chat.messages.length - 1];
    const fm = frontmatter({
      source: chat.app,
      chat: chat.name,
      ...(first ? { from: isoDay(first.time), to: isoDay(last.time) } : {}),
      participants: participants(chat.messages),
      messages: chat.messages.length,
    });
    return [{ path: `${name}.md`, content: `${fm}\n# ${chat.name}\n\n${body}\n`, messages: chat.messages.length }];
  }
  const byDay = new Map<string, ChatMessage[]>();
  for (const m of chat.messages) byDay.set(isoDay(m.time), [...(byDay.get(isoDay(m.time)) ?? []), m]);
  return [...byDay].map(([day, ms]) => {
    const fm = frontmatter({ source: chat.app, chat: chat.name, date: day, participants: participants(ms), messages: ms.length });
    return { path: `${day}.md`, content: `${fm}\n# ${chat.name} · ${day}\n\n${ms.map((m) => messageBlock(chat, m, opts, false)).join("\n\n")}\n`, messages: ms.length };
  });
}
