/**
 * One message shared or pasted from a chat app into the inbox (plan W5.7):
 * WhatsApp's "copy" format `[14:03, 12.11.2026] Tal: text` (time first),
 * an export line `12.11.2026, 14:03 - Tal: text`, or Telegram Desktop's
 * `Tal, [12.11.2026 14:03]` above the text. The inbox entry then names the
 * app, the author and when it was written, and keeps the text as it was.
 * Anything else: null (the share is captured as plain text, as before).
 */
import { asciiDigits, headerOf } from "./whatsapp";

export interface SharedChatMessage {
  app: "WhatsApp" | "Telegram";
  author: string;
  when: string;
  text: string;
}

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const pad = (n: number | string) => String(n).padStart(2, "0");
const COPY = /^\[(\d{1,2}):(\d{2})(?:\s*([^\],\d][^\],]*))?,\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})\]\s*([^:]{1,80}):\s?([\s\S]*)$/;
const TG = /^(.{1,80}),\s*\[(\d{1,2})[./](\d{1,2})[./](\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\]\s*$/;
const PM = /^(pm|אחה״צ|אחה"צ|م)$/i;

const year = (y: string) => (y.length === 2 ? `20${y}` : y);

export function parseSharedChatMessage(input: string): SharedChatMessage | null {
  const text = asciiDigits(input.replace(BIDI, "").replace(/\r\n?/g, "\n").trim());
  if (!text) return null;
  const [first, ...rest] = text.split("\n");
  let m = COPY.exec(text);
  if (m) {
    let hh = +m[1];
    if (m[3] && PM.test(m[3].trim()) && hh < 12) hh += 12;
    // The copy format follows the phone's order; day first unless the second part can't be a month.
    const [d, mo] = +m[5] > 12 ? [m[5], m[4]] : [m[4], m[5]];
    return { app: "WhatsApp", author: m[7].trim(), when: `${year(m[6])}-${pad(mo)}-${pad(d)} ${pad(hh)}:${m[2]}`, text: m[8].trim() };
  }
  m = TG.exec(first);
  if (m && rest.join("\n").trim()) {
    return { app: "Telegram", author: m[1].trim(), when: `${m[4]}-${pad(m[3])}-${pad(m[2])} ${pad(m[5])}:${m[6]}`, text: rest.join("\n").trim() };
  }
  const h = headerOf(first);
  if (h) {
    const i = h.rest.indexOf(": ");
    if (i > 0 && i <= 80) {
      const dmy = h.a <= 31 && (h.sep !== "/" || h.a > 12 || !h.ampm);
      const [d, mo, y] = h.a > 31 ? [h.c, h.b, h.a] : dmy ? [h.a, h.b, h.c] : [h.b, h.a, h.c];
      let hh = h.hh;
      if (h.ampm && PM.test(h.ampm) && hh < 12) hh += 12;
      return { app: "WhatsApp", author: h.rest.slice(0, i).trim(), when: `${y < 100 ? 2000 + y : y}-${pad(mo)}-${pad(d)} ${pad(hh)}:${pad(h.mm)}`, text: [h.rest.slice(i + 2), ...rest].join("\n").trim() };
    }
  }
  return null;
}

/** The inbox text for a shared chat message: "WhatsApp · Tal · 2026-11-12 14:03", then the message. */
export function chatShareText(input: string): string | null {
  const p = parseSharedChatMessage(input);
  return p ? `${p.app} · ${p.author} · ${p.when}\n${p.text}` : null;
}
