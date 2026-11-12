/**
 * A chat export, read into one shape for WhatsApp and Telegram (plan W5.7).
 * Times are the export's local wall-clock time: both apps write them in the
 * phone's time zone, with no offset, so they are kept as they are.
 */

export type ChatApp = "whatsapp" | "telegram";

export interface ChatTime {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

export interface ChatMessage {
  time: ChatTime;
  /** Null for a system line ("Messages are end-to-end encrypted", "X joined"). */
  author: string | null;
  text: string;
  /** File names this message attaches, as the export names them. */
  media: string[];
  /** The export said the media was left out ("<Media omitted>"). */
  omitted?: boolean;
  /** Telegram: the message it answers, and who it was forwarded from. */
  replyTo?: number;
  forwardedFrom?: string;
  id?: number;
}

export interface ParsedChat {
  app: ChatApp;
  /** The chat's name: the contact or group (file name or the export's own). */
  name: string;
  messages: ChatMessage[];
  /** Lines or records that could not be read at all (kept in the report, never dropped silently). */
  unreadable: string[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export const isoDay = (t: ChatTime): string => `${t.y}-${pad(t.m)}-${pad(t.d)}`;
export const clock = (t: ChatTime): string => `${pad(t.hh)}:${pad(t.mm)}`;
