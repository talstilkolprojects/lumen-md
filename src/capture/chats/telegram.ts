/**
 * Telegram Desktop's "Export chat history" in JSON (plan W5.7): result.json
 * of one chat ({ name, type, messages }) or of the whole account
 * ({ chats: { list: [...] } }). Dates are local wall-clock time
 * ("2026-11-12T14:03:12"); text is a string or a list of plain strings and
 * entities ({ type, text, href? }); media sit next to it (photos/…,
 * files/…, voice_messages/…) and are named by `photo` / `file`.
 */
import type { ChatMessage, ParsedChat, ChatTime } from "./types";

interface TgEntity {
  type?: string;
  text?: string;
  href?: string;
}

interface TgMessage {
  id?: number;
  type?: string;
  date?: string;
  from?: string | null;
  actor?: string | null;
  action?: string;
  text?: string | Array<string | TgEntity>;
  photo?: string;
  file?: string;
  thumbnail?: string;
  media_type?: string;
  reply_to_message_id?: number;
  forwarded_from?: string | null;
  sticker_emoji?: string;
  poll?: { question?: string; answers?: Array<{ text?: string }> };
  location_information?: { latitude?: number; longitude?: number };
  contact_information?: { first_name?: string; last_name?: string; phone_number?: string };
}

interface TgChat {
  name?: string | null;
  type?: string;
  id?: number;
  messages?: TgMessage[];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/** Telegram's rich text → Markdown (bold, italic, code, links, spoilers stay plain). */
export function tgText(text: TgMessage["text"]): string {
  if (typeof text === "string") return text;
  if (!Array.isArray(text)) return "";
  return text
    .map((part) => {
      if (typeof part === "string") return part;
      const s = part.text ?? "";
      switch (part.type) {
        case "bold":
          return s.trim() ? `**${s}**` : s;
        case "italic":
          return s.trim() ? `*${s}*` : s;
        case "strikethrough":
          return s.trim() ? `~~${s}~~` : s;
        case "code":
          return "`" + s.replace(/`/g, "ˋ") + "`";
        case "pre":
          return "\n```\n" + s + "\n```\n";
        case "text_link":
          return part.href ? `[${s}](${part.href})` : s;
        case "link":
          return /^https?:\/\//.test(s) ? `<${s}>` : s;
        default:
          return s;
      }
    })
    .join("");
}

function extras(m: TgMessage): string[] {
  const out: string[] = [];
  if (m.sticker_emoji && m.media_type === "sticker") out.push(m.sticker_emoji);
  if (m.poll?.question) out.push([`📊 ${m.poll.question}`, ...(m.poll.answers ?? []).map((a) => `- ${a.text ?? ""}`)].join("\n"));
  if (m.location_information?.latitude !== undefined) out.push(`📍 ${m.location_information.latitude}, ${m.location_information.longitude}`);
  if (m.contact_information) out.push(`👤 ${[m.contact_information.first_name, m.contact_information.last_name].filter(Boolean).join(" ")} ${m.contact_information.phone_number ?? ""}`.trim());
  return out;
}

function one(chat: TgChat, fallbackName: string): ParsedChat {
  const messages: ChatMessage[] = [];
  const unreadable: string[] = [];
  for (const m of chat.messages ?? []) {
    const d = DATE.exec(m.date ?? "");
    if (!d) {
      unreadable.push(JSON.stringify(m).slice(0, 200));
      continue;
    }
    const time: ChatTime = { y: +d[1], m: +d[2], d: +d[3], hh: +d[4], mm: +d[5], ss: +d[6] };
    const service = m.type === "service";
    const body = [tgText(m.text), ...extras(m)].filter((x) => x.trim()).join("\n");
    const media = [m.photo, m.file].filter((f): f is string => !!f && !/^\(File not included/i.test(f));
    const omitted = [m.photo, m.file].some((f) => !!f && /^\(File not included/i.test(f));
    messages.push({
      id: m.id,
      time,
      author: service ? null : (m.from ?? null),
      text: service ? [m.actor, m.action?.replace(/_/g, " "), body].filter(Boolean).join(" · ") : body,
      media,
      ...(omitted ? { omitted } : {}),
      ...(m.reply_to_message_id ? { replyTo: m.reply_to_message_id } : {}),
      ...(m.forwarded_from ? { forwardedFrom: m.forwarded_from } : {}),
    });
  }
  return { app: "telegram", name: (chat.name ?? "").trim() || fallbackName, messages, unreadable };
}

export function looksLikeTelegram(json: unknown): boolean {
  const j = json as { messages?: unknown; chats?: { list?: unknown } } | null;
  return !!j && (Array.isArray(j.messages) || Array.isArray(j.chats?.list));
}

/** Every chat in a Telegram export (one, or all of an account's). */
export function parseTelegram(json: unknown, fallbackName = "Telegram"): ParsedChat[] {
  const j = json as TgChat & { chats?: { list?: TgChat[] } };
  if (Array.isArray(j.chats?.list)) return j.chats.list.map((c, i) => one(c, `${fallbackName} ${i + 1}`));
  return [one(j, fallbackName)];
}
