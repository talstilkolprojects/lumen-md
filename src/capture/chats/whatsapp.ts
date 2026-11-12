/**
 * WhatsApp's "Export chat" text (plan W5.7): `_chat.txt` from an iPhone,
 * `WhatsApp Chat with X.txt` from Android, in the phone's language.
 *
 *   Android  12.11.2026, 14:03 - טל: שלום           (he-IL, 24 h, dots)
 *            11/12/26, 2:03 PM - Tal: hi             (en-US, 12 h, M/D/YY)
 *   iPhone   [12.11.2026, 14:03:12] טל: שלום
 *            [12/11/2026, 14:03:12] Tal: hi
 *
 * Hebrew 12-hour clocks write לפנה״צ / אחה״צ, Arabic ص / م, and Arabic
 * exports may use Arabic-Indic digits. iPhones put U+200E before lines that
 * hold an attachment; both apps may put bidi marks around names and times.
 * Day/month order is not written anywhere: it is inferred from the whole
 * file (a part over 12 is the day), and for an all-ambiguous file from the
 * separator — dots and dashes mean day first, slashes in a 12-hour file
 * mean the US month first, otherwise day first (Israel, Europe).
 *
 * Attachments: Android "IMG-20261112-WA0001.jpg (file attached)" /
 * "(קובץ מצורף)"; iPhone "<attached: 00000012-PHOTO-…jpg>" / "<מצורף: …>".
 * Without media: "<Media omitted>" / "<המדיה לא נכללה>" and their kin.
 */
import type { ChatMessage, ParsedChat, ChatTime } from "./types";

const BIDI = /[‎‏‪-‮⁦-⁩؜﻿]/g;
const NBSP = /[  ]/g;

/** Arabic-Indic and Persian digits → ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

const AM = /^(am|a\.m\.|לפנה״צ|לפנה"צ|לפני הצהריים|ص|صباحًا|صباحا|vorm\.|du matin)$/i;
const PM = /^(pm|p\.m\.|אחה״צ|אחה"צ|אחר הצהריים|م|مساءً|مساء|nachm\.|de l'après-midi)$/i;

// date, time and optional am/pm; then " - " (Android) or "] " (iPhone)
const IOS = /^\[(\d{1,4})([./-])(\d{1,2})\2(\d{2,4})[,،]?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([^\]\d]*?)\]\s?(.*)$/;
const ANDROID = /^(\d{1,4})([./-])(\d{1,2})\2(\d{2,4})[,،]?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([^\s\d-][^-]*?)?\s+[-–]\s(.*)$/;

interface RawLine {
  a: number;
  b: number;
  c: number;
  sep: string;
  hh: number;
  mm: number;
  ss: number;
  ampm: string;
  rest: string;
}

export function headerOf(line: string): RawLine | null {
  const clean = asciiDigits(line.replace(BIDI, "").replace(NBSP, " ")).trimStart();
  const m = IOS.exec(clean) ?? ANDROID.exec(clean);
  if (!m) return null;
  return { a: +m[1], sep: m[2], b: +m[3], c: +m[4], hh: +m[5], mm: +m[6], ss: m[7] ? +m[7] : 0, ampm: (m[8] ?? "").trim(), rest: m[9] ?? "" };
}

type Order = "dmy" | "mdy" | "ymd";

/** Day/month order for a whole file, from every header line. */
export function inferOrder(lines: RawLine[]): Order {
  if (lines.some((l) => l.a > 31)) return "ymd";
  if (lines.some((l) => l.a > 12)) return "dmy";
  if (lines.some((l) => l.b > 12)) return "mdy";
  const sep = lines[0]?.sep ?? "/";
  if (sep === "." || sep === "-") return "dmy";
  return lines.some((l) => l.ampm) ? "mdy" : "dmy";
}

function toTime(l: RawLine, order: Order): ChatTime {
  const [rawY, m, d] = order === "ymd" ? [l.a, l.b, l.c] : order === "mdy" ? [l.c, l.a, l.b] : [l.c, l.b, l.a];
  const y = rawY < 100 ? rawY + 2000 : rawY;
  let hh = l.hh;
  if (l.ampm) {
    if (AM.test(l.ampm) && hh === 12) hh = 0;
    else if (PM.test(l.ampm) && hh < 12) hh += 12;
  }
  return { y, m, d, hh, mm: l.mm, ss: l.ss };
}

const ATTACHED_IOS = /^<(?:attached|מצורף|مرفق|angehängt|pièce jointe|joint)\s*:\s*([^>]+)>\s*$/i;
const ATTACHED_ANDROID = /^(.+?\.[A-Za-z0-9]{1,5})\s+\((?:file attached|קובץ מצורף|ملف مرفق|Datei angehängt|fichier joint)\)\s*$/i;
const OMITTED = /^<?(?:Media omitted|המדיה לא נכללה|מדיה הושמטה|تم استبعاد الوسائط|الوسائط غير مضمنة|Medien ausgeschlossen|Medien weggelassen|médias omis|image omitted|video omitted|audio omitted|sticker omitted|GIF omitted|document omitted|תמונה הושמטה|סרטון הושמט|הקלטה הושמטה)>?$/i;

/** Split "Name: text" — the name is the part before the first ": " (names may hold ":" only in very rare cases). */
function splitAuthor(rest: string): { author: string | null; text: string } {
  const i = rest.indexOf(": ");
  if (i <= 0 || i > 80) return { author: null, text: rest };
  return { author: rest.slice(0, i).replace(BIDI, "").trim(), text: rest.slice(i + 2) };
}

function readBody(msg: ChatMessage): void {
  const lines = msg.text.split("\n");
  const kept: string[] = [];
  for (const raw of lines) {
    const l = raw.replace(BIDI, "").trim();
    let m = ATTACHED_IOS.exec(l);
    if (m) {
      msg.media.push(m[1].trim());
      continue;
    }
    m = ATTACHED_ANDROID.exec(l);
    if (m) {
      msg.media.push(m[1].trim());
      continue;
    }
    if (OMITTED.test(l)) {
      msg.omitted = true;
      continue;
    }
    kept.push(raw.replace(/^[‎‏]+/, ""));
  }
  msg.text = kept.join("\n").replace(/\s+$/, "");
}

/** The chat's name from the export's file name ("WhatsApp Chat with Mom.txt", "WhatsApp Chat - Family.zip", "צ'אט WhatsApp עם אמא.txt"). */
export function chatNameFromFile(name: string): string {
  const stem = name.replace(/^.*[\\/]/, "").replace(/\.(txt|zip)$/i, "");
  const m = /^(?:WhatsApp Chat (?:with|-)\s*|צ['׳]אט WhatsApp עם\s*|צ['׳]אט ב-?WhatsApp עם\s*|دردشة WhatsApp مع\s*|WhatsApp-Chat mit\s*|Discussion WhatsApp avec\s*)(.+)$/i.exec(stem);
  const out = (m ? m[1] : stem).trim();
  return out && out !== "_chat" ? out : "WhatsApp";
}

export function looksLikeWhatsApp(text: string): boolean {
  let n = 0;
  for (const line of text.split(/\r\n?|\n/, 20)) if (headerOf(line)) n++;
  return n >= 1;
}

export function parseWhatsApp(text: string, fileName = "_chat.txt"): ParsedChat {
  const lines = text.replace(/^﻿/, "").split(/\r\n?|\n/);
  const heads = lines.map(headerOf);
  const order = inferOrder(heads.filter((h): h is RawLine => !!h));
  const messages: ChatMessage[] = [];
  const unreadable: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = heads[i];
    if (h) {
      const { author, text: body } = splitAuthor(h.rest);
      messages.push({ time: toTime(h, order), author, text: body, media: [] });
    } else if (messages.length) {
      messages[messages.length - 1].text += "\n" + lines[i];
    } else if (lines[i].trim()) {
      unreadable.push(lines[i]);
    }
  }
  for (const m of messages) readBody(m);
  return { app: "whatsapp", name: chatNameFromFile(fileName), messages, unreadable };
}
