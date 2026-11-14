/**
 * Plan W5.7 against W6.38's real corpus (#516): 30 WhatsApp exports, Android
 * and iPhone, in Hebrew, English, Arabic and German, 12 and 24 h, with
 * Arabic-Indic digits, bidi marks, attachments, omitted media and CRLF. The
 * folder is the same bytes as #516's `fixtures/real-corpus/whatsapp`, with its
 * `expected.json`. Every chat must come out whole: the same messages, each
 * with its author, its minute and its body (text, attachment or "omitted").
 * The gate is 100%: the corpus is fixed, so any slip is a regression.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWhatsApp } from "../capture/chats/whatsapp";
import type { ChatMessage } from "../capture/chats/types";

const DIR = join(__dirname, "fixtures/real-corpus/whatsapp");

interface Expected {
  file: string;
  variant: string;
  messages: { kind: "text" | "attach" | "omitted"; author: string; hh: number; mm: number; y: number; m: number; d: number; text?: string; file?: string }[];
}

// The corpus writes names with RLM around them ("‏מיכל‏"), as WhatsApp does; names are compared without bidi marks.
const noMarks = (s: string | null) => (s ?? "").replace(/[‎‏‪-‮⁦-⁩]/g, "").trim();
// The export's first line is WhatsApp's encryption notice: a system line, not a message of the chat.
const NOTICE = /encrypted|מוצפנות|مشفرة|verschlüsselt/;

function score() {
  const all = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as Expected[];
  let whole = 0;
  let total = 0;
  let right = 0;
  const wrong: string[] = [];
  for (const c of all) {
    const name = c.file.replace(/^wa\d\d-.*?-(?=WhatsApp|_chat)/, "");
    const got = parseWhatsApp(readFileSync(join(DIR, c.file), "utf8"), name).messages.filter((m: ChatMessage) => m.author !== null && !NOTICE.test(m.text));
    let ok = got.length === c.messages.length;
    c.messages.forEach((e, i) => {
      total++;
      const g = got[i];
      const good =
        !!g &&
        noMarks(g.author) === noMarks(e.author) &&
        g.time.y === e.y && g.time.m === e.m && g.time.d === e.d && g.time.hh === e.hh && g.time.mm === e.mm &&
        (e.kind === "text" ? g.text === e.text : e.kind === "attach" ? g.media.includes(e.file!) : !!g.omitted);
      if (good) right++;
      else {
        ok = false;
        wrong.push(`${c.file} #${i}`);
      }
    });
    if (ok) whole++;
  }
  return { chats: all.length, whole, total, right, wrong };
}

describe("W5.7 WhatsApp parser on W6.38's real corpus", () => {
  it("30/30 chats whole and 291/291 messages: author, minute and body", () => {
    const s = score();
    expect(s.wrong).toEqual([]);
    expect([s.whole, s.chats]).toEqual([30, 30]);
    expect([s.right, s.total]).toEqual([291, 291]);
  });

  it("message text is byte for byte what the export wrote, Arabic-Indic digits included", () => {
    const f = readdirFirst("android-ar-digits");
    const c = parseWhatsApp(readFileSync(join(DIR, f), "utf8"));
    expect(c.messages.some((m) => m.text === "سأصل الساعة ٨")).toBe(true);
    expect(c.messages.every((m) => !/سأصل الساعة 8/.test(m.text))).toBe(true);
  });
});

function readdirFirst(variant: string): string {
  const all = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as Expected[];
  return all.find((c) => c.variant === variant && c.messages.some((m) => m.text === "سأصل الساعة ٨"))!.file;
}
