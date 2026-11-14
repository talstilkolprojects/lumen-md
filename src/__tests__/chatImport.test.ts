/**
 * Plan W5.7 — WhatsApp and Telegram capture: golden tests on synthetic
 * exports (WhatsApp Android and iPhone, in Hebrew, English and Arabic;
 * Telegram Desktop JSON, one chat and a whole account). Every message is
 * counted in and out, media are copied next to the notes, Hebrew dates parse
 * in both export locales, and nothing touches the network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWhatsApp, inferOrder, headerOf, chatNameFromFile } from "../capture/chats/whatsapp";
import { parseTelegram } from "../capture/chats/telegram";
import { renderChat, whatsappMarkdown, type RenderStrings } from "../capture/chats/notes";
import { planChatImport, readChatFiles, writeChatImport, type VaultWriter } from "../capture/chats/importChats";
import { parseSharedChatMessage, chatShareText } from "../capture/chats/share";
import { unzip, zip } from "../storage/zip";
import type { ParsedChat } from "../capture/chats/types";

const DIR = join(__dirname, "fixtures/chats");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const bytes = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
const S: RenderStrings = { missing: "(not in the export)", omitted: "(media left out of the export)", forwarded: (n) => `forwarded from ${n}`, reply: (i) => `in reply to message ${i}` };
const when = (c: ParsedChat, i: number) => {
  const t = c.messages[i].time;
  return `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")} ${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(2, "0")}`;
};

/** Every synthetic export: its file, its app, how many messages, the first and last, its media. */
const GOLDEN = [
  { file: "WhatsApp Chat with משפחה.txt", name: "משפחה", n: 10, first: ["2026-11-12 09:15", null], last: ["2026-11-13 07:31", "טל"], media: ["IMG-20261112-WA0001.jpg", "PTT-20261113-WA0002.opus"], omitted: 1 },
  { file: "WhatsApp Chat with Sam.txt", name: "Sam", n: 6, first: ["2026-11-12 09:05", null], last: ["2026-11-13 13:30", "Sam"], media: ["DOC-20261112-WA0003.pdf"], omitted: 1 },
  { file: "ios-he/_chat.txt", name: "WhatsApp", n: 4, first: ["2026-11-12 18:02", "רועי"], last: ["2026-11-12 18:05", "טל"], media: ["00000003-PHOTO-2026-11-12-18-04-02.jpg"], omitted: 0 },
  { file: "ios-en/_chat.txt", name: "WhatsApp", n: 4, first: ["2026-11-13 08:00", "Alex"], last: ["2026-11-14 21:45", "Alex"], media: ["00000002-PHOTO-2026-11-13-08-01-10.jpg"], omitted: 0 },
  { file: "WhatsApp Chat with سارة.txt", name: "سارة", n: 3, first: ["2026-11-12 09:05", "سارة"], last: ["2026-11-13 10:00", "سارة"], media: ["IMG-20261113-WA0004.jpg"], omitted: 0 },
  { file: "WhatsApp Chat with נועה.txt", name: "נועה", n: 4, first: ["2026-11-12 09:05", "נועה"], last: ["2026-11-12 23:59", "טל"], media: [], omitted: 0 },
] as const;

describe("W5.7 WhatsApp exports (golden)", () => {
  for (const g of GOLDEN) {
    it(`${g.file}: ${g.n} messages, none unreadable, media named`, () => {
      const c = parseWhatsApp(read(g.file), g.file.split("/").pop());
      expect(c.name).toBe(g.name);
      expect(c.messages.length).toBe(g.n);
      expect(c.unreadable).toEqual([]);
      expect([when(c, 0), c.messages[0].author]).toEqual([...g.first]);
      expect([when(c, g.n - 1), c.messages[g.n - 1].author]).toEqual([...g.last]);
      expect(c.messages.flatMap((m) => m.media)).toEqual([...g.media]);
      expect(c.messages.filter((m) => m.omitted).length).toBe(g.omitted);
    });
  }

  it("Hebrew dates: the Hebrew (dots, 24 h) and English (M/D/YY, 12 h) exports give the same calendar days", () => {
    const he = parseWhatsApp(read("WhatsApp Chat with משפחה.txt"));
    const en = parseWhatsApp(read("WhatsApp Chat with Sam.txt"));
    expect(new Set(he.messages.map((m) => `${m.time.m}/${m.time.d}`))).toEqual(new Set(["11/12", "11/13"]));
    expect(new Set(en.messages.map((m) => `${m.time.m}/${m.time.d}`))).toEqual(new Set(["11/12", "11/13"]));
    // 12:15 AM is just after midnight, 12:00 PM is noon.
    expect(when(en, 4)).toBe("2026-11-13 00:15");
    expect(when(en, 2)).toBe("2026-11-12 12:00");
  });

  it("Hebrew 12-hour clocks: לפנה״צ / אחה״צ", () => {
    const c = parseWhatsApp(read("WhatsApp Chat with נועה.txt"));
    expect(c.messages.map((m) => `${m.time.hh}:${String(m.time.mm).padStart(2, "0")}`)).toEqual(["9:05", "12:30", "0:10", "23:59"]);
  });

  it("day/month order comes from the whole file; ambiguous slashes in a 24 h file are day first (Israel)", () => {
    const h = (s: string) => headerOf(s)!;
    expect(inferOrder([h("03/04/2026, 10:00 - A: x"), h("13/04/2026, 10:00 - A: y")])).toBe("dmy");
    expect(inferOrder([h("04/13/26, 10:00 AM - A: x")])).toBe("mdy");
    expect(inferOrder([h("03/04/2026, 10:00 - A: x")])).toBe("dmy");
    expect(inferOrder([h("03.04.2026, 10:00 - A: x")])).toBe("dmy");
    expect(inferOrder([h("2026-04-03, 10:00 - A: x")])).toBe("ymd");
  });

  it("W6.38: Arabic-Indic digits are read in the date and time only; the message keeps its own digits", () => {
    const c = parseWhatsApp("٠٩/١٢/٢٠٢٦, ٠٨:٠٥ - أحمد: سأصل الساعة ٨ مع ٢ أصدقاء\n٠٩/١٢/٢٠٢٦, ٠٨:٠٦ - أحمد: IMG-٢٠٢٦١٢٠٩-WA٠٠٠١.jpg (file attached)");
    expect(c.messages[0].text).toBe("سأصل الساعة ٨ مع ٢ أصدقاء");
    expect([c.messages[0].time.d, c.messages[0].time.m, c.messages[0].time.hh, c.messages[0].time.mm]).toEqual([9, 12, 8, 5]);
    expect(c.messages[1].media).toEqual(["IMG-20261209-WA0001.jpg"]);
    // Bidi marks and no-break spaces inside a message are the writer's, not the export's: kept.
    const m = parseWhatsApp("[12.11.2026, 14:03:12] טל: מחיר\u00a0100\u200f₪ (\u200eABC\u200e)");
    expect(m.messages[0].text).toBe("מחיר" + String.fromCharCode(0xa0) + "100" + String.fromCharCode(0x200f) + "₪ (" + String.fromCharCode(0x200e) + "ABC" + String.fromCharCode(0x200e) + ")");
  });

  it("W6.38: an Arabic or Hebrew 12-hour clock with slashes is day first; a Latin AM/PM is month first; dates that only run forward one way decide", () => {
    const h = (s: string) => headerOf(s)!;
    expect(inferOrder([h("[12/07/2026, 9:58:01 ص] سارة: x"), h("[12/07/2026, 1:02:33 م] أحمد: y")])).toBe("dmy");
    expect(inferOrder([h("12/07/2026, 9:58 לפנה״צ - טל: x")])).toBe("dmy");
    expect(inferOrder([h("12/07/26, 9:58 AM - Tal: x")])).toBe("mdy");
    expect(inferOrder([h("12/07/26, 9:58 p.m. - Tal: x")])).toBe("mdy");
    // 01/02 then 02/01: under day first the chat would go back from 1 Feb to 2 Jan; month first runs forward.
    expect(inferOrder([h("01/02/26, 9:58 - A: x"), h("02/01/26, 9:58 - A: y")])).toBe("mdy");
    expect(inferOrder([h("02/01/26, 9:58 PM - A: x"), h("01/02/26, 9:58 PM - A: y")])).toBe("dmy");
    const c = parseWhatsApp("[12/07/2026, 9:58:01 ص] سارة: صباح الخير\n[12/07/2026, 1:02:33 م] أحمد: شكراً");
    expect([c.messages[0].time.d, c.messages[0].time.m, c.messages[1].time.hh]).toEqual([12, 7, 13]);
  });

  it("W6.38: iPhone omitted media in Hebrew, as WhatsApp for iOS writes it, with or without marks and brackets", () => {
    const lines = ["התמונה הושמטה", "סרטון הווידאו הושמט", "קטע קול הושמט", "GIF הושמט", "סטיקר הושמט", "מסמך הושמט", "כרטיס איש קשר הושמט", "<התמונה הושמטה>", "image omitted", "Contact card omitted"];
    const rlm = String.fromCharCode(0x200f);
    const lrm = String.fromCharCode(0x200e);
    const text = lines.map((l, i) => `${lrm}[13.03.2026, 11:${String(10 + i)}:40] יוסי: ${i % 2 ? lrm : rlm}${l}`).join("\n");
    const c = parseWhatsApp(text);
    expect(c.messages.map((m) => [m.omitted, m.text])).toEqual(lines.map(() => [true, ""]));
    // Android's single line, and a view-once voice message.
    expect(parseWhatsApp("19.8.2025, 11:23 - טל: <הודעה קולית להאזנה חד פעמית הושמטה>").messages[0].omitted).toBe(true);
    // A document left out keeps its name; a message that only mentions the words stays a message.
    const d = parseWhatsApp(`[14/08/26, 13:51:12] Tal: ${lrm}coursebooks.pdf • ${lrm}61 pages ${lrm}document omitted\n[14/08/26, 13:52:00] Tal: the image omitted from the deck`);
    expect([d.messages[0].omitted, d.messages[0].text]).toEqual([true, "coursebooks.pdf"]);
    expect([d.messages[1].omitted, d.messages[1].text]).toEqual([undefined, "the image omitted from the deck"]);
  });

  it("multi-line messages stay one message; bidi marks are dropped from names and markers", () => {
    const c = parseWhatsApp(read("ios-he/_chat.txt"));
    expect(c.messages[3].text).toBe("שורה ראשונה\nשורה שנייה\n- לא רשימה");
    expect(c.messages[2].author).toBe("רועי");
  });

  it("chat names from the export's file name, in Hebrew and English", () => {
    expect(chatNameFromFile("WhatsApp Chat with Mom.txt")).toBe("Mom");
    expect(chatNameFromFile("WhatsApp Chat - Family.zip")).toBe("Family");
    expect(chatNameFromFile("צ'אט WhatsApp עם אמא.txt")).toBe("אמא");
    expect(chatNameFromFile("_chat.txt")).toBe("WhatsApp");
  });

  it("WhatsApp's marks become Markdown, and a line that would start a block is escaped", () => {
    expect(whatsappMarkdown("מביא *חומוס* ו_פיתות_ ~לא~")).toBe("מביא **חומוס** ו*פיתות* ~~לא~~");
    expect(whatsappMarkdown("# not a heading\n- not a list\n1. no")).toBe("\\# not a heading\n\\- not a list\n\\1. no");
    expect(whatsappMarkdown("2*3*4 snake_case_name")).toBe("2*3*4 snake_case_name");
  });
});

describe("W5.7 Telegram Desktop exports (golden)", () => {
  it("one chat: text entities, a reply, a forward, media and a missing file", () => {
    const [c] = parseTelegram(JSON.parse(read("telegram-result.json")));
    expect(c.name).toBe("קבוצת לימוד");
    expect(c.messages.length).toBe(9);
    expect(c.messages[0].author).toBeNull();
    expect(c.messages[2].text).toBe("היי! ראו **כאן**: [הסיכום](https://example.com/sum) וגם <https://example.com/x>");
    expect(c.messages[2].replyTo).toBe(2);
    expect(c.messages[3].media).toEqual(["photos/photo_1@12-11-2026_10-03-00.jpg"]);
    expect(c.messages[5].forwardedFrom).toBe("ערוץ החדשות");
    expect(c.messages[6].omitted).toBe(true);
    expect(c.messages[6].media).toEqual([]);
    expect(when(c, 8)).toBe("2026-11-13 08:08");
  });

  it("a whole-account export: every chat, an unnamed one gets a name", () => {
    const chats = parseTelegram(JSON.parse(read("telegram-account.json")), "Telegram");
    expect(chats.map((c) => [c.name, c.messages.length])).toEqual([
      ["Sam", 2],
      ["Telegram 2", 1],
    ]);
  });
});

describe("W5.7 notes: per day or per chat, media attached, no message lost", () => {
  it("golden: the Hebrew WhatsApp export's first day", async () => {
    const r = await readChatFiles([{ name: "WhatsApp Chat with משפחה.txt", bytes: bytes("WhatsApp Chat with משפחה.txt") }, { name: "IMG-20261112-WA0001.jpg", bytes: new Uint8Array([1, 2, 3]) }], unzip);
    const [p] = planChatImport(r, "day", S);
    expect(p.folder).toBe("משפחה (WhatsApp)");
    expect(p.notes.map((n) => n.path)).toEqual(["2026-11-12.md", "2026-11-13.md"]);
    expect(p.notes[0].content).toBe(read("expected/whatsapp-he-2026-11-12.md"));
    expect(p.attachments.map((a) => a.path)).toEqual(["media/IMG-20261112-WA0001.jpg"]);
    expect(p.missing).toEqual(["PTT-20261113-WA0002.opus"]);
  });

  it("golden: the Telegram chat as one note with day headings", async () => {
    const r = await readChatFiles([{ name: "result.json", bytes: bytes("telegram-result.json") }], unzip);
    const [p] = planChatImport(r, "chat", S);
    expect(p.notes.map((n) => n.path)).toEqual(["קבוצת לימוד.md"]);
    expect(p.notes[0].content).toBe(read("expected/telegram-he-chat.md"));
  });

  it("every message of every export is in the notes, once, in order", () => {
    const all: ParsedChat[] = [...GOLDEN.map((g) => parseWhatsApp(read(g.file), g.file)), ...parseTelegram(JSON.parse(read("telegram-result.json"))), ...parseTelegram(JSON.parse(read("telegram-account.json")))];
    let total = 0;
    for (const c of all) {
      for (const grouping of ["day", "chat"] as const) {
        const notes = renderChat(c, { grouping, mediaPath: () => null, strings: S });
        expect(notes.reduce((s, n) => s + n.messages, 0), `${c.name} ${grouping}`).toBe(c.messages.length);
        const text = notes.map((n) => n.content).join("\n");
        // Each message has its own time stamp in the notes.
        const stamps = text.match(/^(\*\*|\*)\d{2}:\d{2}/gm) ?? [];
        expect(stamps.length, `${c.name} ${grouping}`).toBe(c.messages.length);
      }
      total += c.messages.length;
    }
    expect(total).toBe(31 + 9 + 3);
  });

  it("an iPhone zip: _chat.txt takes the zip's chat name, its photo is copied", async () => {
    const z = await zip([
      { name: "_chat.txt", data: new TextEncoder().encode(read("ios-he/_chat.txt")) },
      { name: "00000003-PHOTO-2026-11-12-18-04-02.jpg", data: new Uint8Array([9, 9]) },
    ]);
    const r = await readChatFiles([{ name: "WhatsApp Chat - רועי.zip", bytes: z }], unzip);
    const [p] = planChatImport(r, "day", S);
    expect(p.folder).toBe("רועי (WhatsApp)");
    expect(p.attachments.map((a) => [a.path, [...a.bytes]])).toEqual([["media/00000003-PHOTO-2026-11-12-18-04-02.jpg", [9, 9]]]);
    expect(p.missing).toEqual([]);
  });

  it("writes into a new Imported/ folder, marked as outside content, never over an existing one", async () => {
    const files = new Map<string, Uint8Array | string>([["Imported/משפחה (WhatsApp)", ""]]);
    const untrusted: string[] = [];
    const vault: VaultWriter = {
      exists: async (p) => files.has(p),
      mkdir: async (p) => void files.set(p, ""),
      writeText: async (p, t) => void files.set(p, t),
      writeBytes: async (p, b) => void files.set(p, b),
      markUntrusted: (f) => void untrusted.push(f),
    };
    const r = await readChatFiles([{ name: "WhatsApp Chat with משפחה.txt", bytes: bytes("WhatsApp Chat with משפחה.txt") }, { name: "IMG-20261112-WA0001.jpg", bytes: new Uint8Array([1]) }], unzip);
    const report = await writeChatImport(planChatImport(r, "day", S), vault);
    expect(report).toEqual({ folders: ["Imported/משפחה (WhatsApp) 2"], chats: 1, messages: 10, notes: 2, attachments: 1, missing: 1, unreadable: 0 });
    expect(untrusted).toEqual(["Imported/משפחה (WhatsApp) 2"]);
    expect(files.get("Imported/משפחה (WhatsApp)")).toBe("");
    expect(files.has("Imported/משפחה (WhatsApp) 2/media/IMG-20261112-WA0001.jpg")).toBe(true);
  });
});

describe("W5.7 one message shared or pasted into the inbox", () => {
  it("WhatsApp's copy format, in Hebrew and English order", () => {
    expect(parseSharedChatMessage("[14:03, 12.11.2026] טל: לקנות חלב")).toEqual({ app: "WhatsApp", author: "טל", when: "2026-11-12 14:03", text: "לקנות חלב" });
    expect(parseSharedChatMessage("[2:03 PM, 11/13/2026] Sam: see you")).toEqual({ app: "WhatsApp", author: "Sam", when: "2026-11-13 14:03", text: "see you" });
  });

  it("an export line and Telegram Desktop's copy format", () => {
    expect(parseSharedChatMessage("12.11.2026, 09:17 - אמא: בוקר טוב")?.when).toBe("2026-11-12 09:17");
    expect(parseSharedChatMessage("מיכל, [12.11.2026 10:02]\nהיי")).toEqual({ app: "Telegram", author: "מיכל", when: "2026-11-12 10:02", text: "היי" });
  });

  it("the inbox text names the app, the author and the time; plain text is left alone", () => {
    expect(chatShareText("[14:03, 12.11.2026] טל: לקנות חלב")).toBe("WhatsApp · טל · 2026-11-12 14:03\nלקנות חלב");
    expect(chatShareText("just a thought")).toBeNull();
    expect(chatShareText("Meeting: 10:00 tomorrow")).toBeNull();
  });
});

describe("W5.7 everything stays on this device", () => {
  const real = globalThis.fetch;
  let calls = 0;
  beforeAll(() => {
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("no network in a chat import");
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = real;
  });

  it("reading, planning and writing a WhatsApp zip and a Telegram export makes 0 requests", async () => {
    const z = await zip([{ name: "WhatsApp Chat with Sam.txt", data: bytes("WhatsApp Chat with Sam.txt") }]);
    const r = await readChatFiles([{ name: "a.zip", bytes: z }, { name: "result.json", bytes: bytes("telegram-result.json") }], unzip);
    const sink: VaultWriter = { exists: async () => false, mkdir: async () => undefined, writeText: async () => undefined, writeBytes: async () => undefined, markUntrusted: () => undefined };
    const report = await writeChatImport(planChatImport(r, "day", S), sink);
    expect(report.messages).toBe(6 + 9);
    expect(calls).toBe(0);
  });
});
