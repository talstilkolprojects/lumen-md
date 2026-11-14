/**
 * Plan W5.18 — local mail import (.eml, .mbox) and Google Takeout (Keep,
 * Docs as exported): RFC 2047 encoded-words, RFC 2231 file names,
 * windows-1255 and ISO-8859-8 (visual and mislabelled logical), threads,
 * Gmail labels, mboxrd quoting, Keep notes and Drive documents. The
 * acceptance numbers: 50/50 Hebrew legacy-charset messages read correctly,
 * and a 5,000-message mbox in under 2 minutes.
 */
import { describe, it, expect } from "vitest";
import { decodeWords, parseMail, parseParams, decodeCharset } from "../capture/mail/mime";
import { splitMbox } from "../capture/mail/mbox";
import { looksVisual, visualToLogical } from "../capture/mail/visual";
import { groupThreads, threadSubject } from "../capture/mail/threads";
import { labelCounts, planMailImport, readMailFiles, type MailPlanOptions } from "../capture/mail/importMail";
import { unzip, zip } from "../storage/zip";

/** Hebrew letters and ASCII → windows-1255 / ISO-8859-8 bytes (the letters share 0xE0–0xFA in both). */
function legacy(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => {
    const n = c.charCodeAt(0);
    if (n >= 0x5d0 && n <= 0x5ea) return 0xe0 + (n - 0x5d0);
    if (n < 0x80) return n;
    throw new Error(`not in the test encoder: ${c}`);
  }));
}
const bin = (b: Uint8Array) => String.fromCharCode(...b);
const qpEncode = (b: Uint8Array) => [...b].map((x) => (x >= 33 && x <= 126 && x !== 61 ? String.fromCharCode(x) : x === 32 ? " " : `=${x.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
const b64 = (b: Uint8Array) => btoa(bin(b));
/** A line in visual order, as an old ISO-8859-8 client stored it. */
const visual = (s: string) => {
  const r = [...s].reverse().map((c) => ({ "(": ")", ")": "(" } as Record<string, string>)[c] ?? c).join("");
  return r.replace(/[A-Za-z0-9./:@-]+/g, (m) => [...m].reverse().join(""));
};
const enc = new TextEncoder();
const raw = (s: string) => enc.encode(s.replace(/\n/g, "\r\n"));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const SENTENCES = [
  "שלום רב, מצורף הסיכום של הפגישה מאתמול.",
  "נא לאשר קבלת המסמך עד יום חמישי בבוקר.",
  "התשלום עבור חודש נובמבר הועבר לחשבון.",
  "הישיבה הבאה תתקיים בשעה 10 בחדר הגדול.",
  "תודה על העזרה, היה נעים לעבוד ביחד.",
  "אני מחכה לתשובה שלך לגבי ההצעה החדשה.",
  "ראו את הקישור www.example.com לפרטים נוספים.",
  "המחיר כולל מע\"מ ומשלוח עד הבית.",
  "בוקר טוב לכולם, מה שלומכם היום?",
  "החשבונית נשלחה אליך בדואר האלקטרוני.",
];

const opts: MailPlanOptions = {
  label: null,
  htmlToMarkdown: (h) => h.replace(/<[^>]+>/g, "").trim(),
  docToMarkdown: async (f) => (f.name.endsWith(".docx") ? `# ${f.name.split("/").pop()}\n\nconverted` : null),
  formatDate: (d) => d.toISOString().slice(0, 16).replace("T", " "),
  noSubject: "(no subject)",
  missing: "(not in the export)",
  skipTrashed: true,
};

describe("W5.18 MIME headers", () => {
  it("RFC 2047: B and Q words in windows-1255, ISO-8859-8-I and UTF-8; adjacent words join", () => {
    expect(decodeWords(`=?windows-1255?B?${b64(legacy("שלום"))}?= =?windows-1255?B?${b64(legacy(" עולם"))}?=`)).toBe("שלום עולם");
    expect(decodeWords(`=?iso-8859-8-i?Q?${qpEncode(legacy("דוח שבועי")).replace(/ /g, "_")}?=`)).toBe("דוח שבועי");
    expect(decodeWords("Re: =?UTF-8?B?16nXnNeV150=?= again")).toBe("Re: שלום again");
    // A UTF-8 character split across two encoded-words.
    const u = enc.encode("ש");
    expect(decodeWords(`=?utf-8?B?${btoa(String.fromCharCode(u[0]))}?= =?utf-8?B?${btoa(String.fromCharCode(u[1]))}?=`)).toBe("ש");
  });

  it("ISO-8859-8 words in visual order are turned around; raw 8-bit headers fall back to windows-1255", () => {
    expect(decodeWords(`=?iso-8859-8?Q?${qpEncode(legacy(visual("פגישת צוות מחר"))).replace(/ /g, "_")}?=`)).toBe("פגישת צוות מחר");
    expect(parseMail(concat(raw("Subject: "), legacy("סיכום"), raw("\n\nbody"))).subject).toBe("סיכום");
  });

  it("RFC 2231 file names (filename*=utf-8''…, continuations)", () => {
    const p = parseParams("attachment; filename*=utf-8''%D7%93%D7%95%D7%97.pdf");
    expect(p.params.filename).toBe("דוח.pdf");
    expect(parseParams('attachment; filename*0="long"; filename*1="name.txt"').params.filename).toBe("longname.txt");
    expect(parseParams('text/plain; charset="windows-1255"; format=flowed')).toEqual({ value: "text/plain", params: { charset: "windows-1255", format: "flowed" } });
  });
});

describe("W5.18 bodies and charsets", () => {
  it("multipart/alternative in windows-1255 QP, a Hebrew-named attachment, plain text preferred", () => {
    const text = SENTENCES[0];
    const eml = concat(
      raw(`From: =?windows-1255?Q?${qpEncode(legacy("טל כהן")).replace(/ /g, "_")}?= <tal@example.com>\nTo: dana@example.com\nSubject: =?windows-1255?B?${b64(legacy("סיכום פגישה"))}?=\nDate: Thu, 12 Nov 2026 14:03:00 +0200\nMessage-ID: <a1@example.com>\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="mix"\n\n--mix\nContent-Type: multipart/alternative; boundary="alt"\n\n--alt\nContent-Type: text/plain; charset=windows-1255\nContent-Transfer-Encoding: quoted-printable\n\n`),
      enc.encode(qpEncode(legacy(text))),
      raw(`\n--alt\nContent-Type: text/html; charset=windows-1255\n\n<p dir="rtl">x</p>\n--alt--\n--mix\nContent-Type: application/pdf; name="x.pdf"\nContent-Disposition: attachment; filename*=utf-8''%D7%93%D7%95%D7%97.pdf\nContent-Transfer-Encoding: base64\n\nJVBERi0xLjQ=\n--mix--\n`),
    );
    const m = parseMail(eml);
    expect(m.subject).toBe("סיכום פגישה");
    expect(m.from).toBe("טל כהן <tal@example.com>");
    expect(m.text?.trim()).toBe(text);
    expect(m.html).toContain("<p");
    expect(m.attachments.map((a) => [a.name, a.type, bin(a.bytes)])).toEqual([["דוח.pdf", "application/pdf", "%PDF-1.4"]]);
    expect(m.date?.toISOString()).toBe("2026-11-12T12:03:00.000Z");
    expect(m.charsets).toEqual(["windows-1255", "windows-1255"]);
  });

  it("ISO-8859-8 is visual by definition, but logical text under that label is left alone", () => {
    const s = SENTENCES[2];
    expect(decodeCharset(legacy(visual(s)), "iso-8859-8")).toBe(s);
    expect(decodeCharset(legacy(s), "iso-8859-8")).toBe(s);
    expect(decodeCharset(legacy(s), "iso-8859-8-i")).toBe(s);
    expect(looksVisual(visual(s))).toBe(true);
    expect(looksVisual(s)).toBe(false);
  });

  it("visual → logical keeps Latin words, numbers and links in their own order and mirrors brackets", () => {
    for (const s of ["הישיבה בשעה 10:30 ב-Zoom", "ראו את www.example.com (קישור) עכשיו", "שולם 250 ש\"ח עבור 3 פריטים"]) expect(visualToLogical(visual(s))).toBe(s);
  });

  it("acceptance: 50 messages in windows-1255 and ISO-8859-8 — 50/50 read correctly", () => {
    let ok = 0;
    for (let i = 0; i < 50; i++) {
      const subject = `${SENTENCES[i % 10].split(" ").slice(0, 3).join(" ")} ${i}`;
      const body = `${SENTENCES[i % 10]}\n${SENTENCES[(i + 3) % 10]}`;
      const visualMail = i % 2 === 1;
      const cs = visualMail ? "iso-8859-8" : "windows-1255";
      const conv = (s: string) => (visualMail ? s.split("\n").map(visual).join("\n") : s);
      const cte = i % 4 < 2 ? "quoted-printable" : "base64";
      const bodyBytes = legacy(conv(body).replace(/\n/g, "\r\n"));
      const eml = concat(
        raw(`From: a@example.com\nSubject: =?${cs}?${i % 3 ? "B" : "Q"}?${i % 3 ? b64(legacy(conv(subject))) : qpEncode(legacy(conv(subject))).replace(/ /g, "_")}?=\nContent-Type: text/plain; charset="${cs}"\nContent-Transfer-Encoding: ${cte}\n\n`),
        enc.encode(cte === "base64" ? b64(bodyBytes) : qpEncode(bodyBytes).replace(/=0D=0A/g, "\r\n")),
      );
      const m = parseMail(eml);
      if (m.subject === subject && m.text?.replace(/\r/g, "").trim() === body) ok++;
    }
    expect(ok).toBe(50);
  });
});

describe("W5.18 mbox, threads and labels", () => {
  const msg = (id: string, subject: string, extra: string, body: string) => `From MAILER-DAEMON Thu Nov 12 14:03:00 2026\nMessage-ID: <${id}>\nFrom: ${id.split("@")[0]} <${id}>\nSubject: ${subject}\nDate: Thu, 12 Nov 2026 1${id.length % 10}:00:00 +0000\n${extra}Content-Type: text/plain; charset=utf-8\n\n${body}\n\n`;

  it("splits an mbox, undoes >From quoting, threads by references and by subject", () => {
    const mbox = raw(
      msg("a@x", "Plans", "X-Gmail-Labels: Inbox,Work\n", "First\n>From the start") +
        msg("bb@x", "Re: Plans", "In-Reply-To: <a@x>\nX-Gmail-Labels: Work\n", "Second") +
        msg("ccc@x", "השב: Plans", "References: <a@x> <bb@x>\nX-Gmail-Labels: \"Work\",Important\n", "Third") +
        msg("dddd@x", "Other", "X-Gmail-Labels: Inbox\n", "Alone"),
    );
    const parts = splitMbox(mbox);
    expect(parts).toHaveLength(4);
    const ms = parts.map(parseMail);
    expect(ms[0].text?.replace(/\r/g, "")).toContain("\nFrom the start");
    expect(groupThreads(ms).map((t) => t.map((m) => m.messageId))).toEqual([["a@x", "bb@x", "ccc@x"], ["dddd@x"]]);
    expect(labelCounts(ms)).toEqual([
      { label: "Work", n: 3 },
      { label: "Inbox", n: 2 },
      { label: "Important", n: 1 },
    ]);
    expect(threadSubject("Re: Fwd: השב: הועבר: Plans")).toBe("plans");
  });

  it("a label filter imports that label only, one note per thread", async () => {
    const mbox = raw(msg("a@x", "Plans", "X-Gmail-Labels: Work\n", "x") + msg("bb@x", "Other", "X-Gmail-Labels: Inbox\n", "y"));
    const read = await readMailFiles([{ name: "All mail.mbox", bytes: mbox }], unzip);
    const plan = await planMailImport(read, { ...opts, label: "Work" });
    expect(plan.folders.map((f) => [f.folder, f.notes.map((n) => n.path), f.messages])).toEqual([["Mail - Work", ["Plans (2026-11-12).md"], 1]]);
    expect(plan.folders[0].notes[0].content).toContain('labels: ["Work"]');
  });

  it("acceptance: a 5,000-message mbox is read and planned in under 2 minutes", async () => {
    const one = (i: number) =>
      i % 2
        ? bin(concat(raw(`From x@y Thu Nov 12 14:03:00 2026\nMessage-ID: <m${i}@x>\nIn-Reply-To: <m${i - 1}@x>\nFrom: Sender ${i % 7} <s${i % 7}@example.com>\nSubject: =?windows-1255?B?${b64(legacy(`שרשור ${Math.floor(i / 10)}`))}?=\nDate: Thu, 12 Nov 2026 14:03:00 +0000\nX-Gmail-Labels: Inbox\nContent-Type: text/plain; charset=windows-1255\nContent-Transfer-Encoding: quoted-printable\n\n`), enc.encode(qpEncode(legacy(SENTENCES[i % 10]))), raw("\n\n")))
        : `From x@y Thu Nov 12 14:03:00 2026\r\nMessage-ID: <m${i}@x>\r\n${i % 10 === 0 ? "" : `References: <m${i - 1}@x>\r\n`}From: Sender <s@example.com>\r\nSubject: Thread ${Math.floor(i / 10)}\r\nDate: Thu, 12 Nov 2026 14:03:00 +0000\r\nContent-Type: multipart/alternative; boundary=b${i}\r\n\r\n--b${i}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>message ${i}</p>\r\n--b${i}--\r\n\r\n`;
    const parts: string[] = [];
    for (let i = 0; i < 5000; i++) parts.push(one(i));
    const mbox = Uint8Array.from(parts.join(""), (c) => c.charCodeAt(0));
    const t0 = performance.now();
    const read = await readMailFiles([{ name: "big.mbox", bytes: mbox }], unzip);
    const plan = await planMailImport(read, opts);
    const ms = performance.now() - t0;
    expect(read.messages).toHaveLength(5000);
    expect(read.unreadable).toEqual([]);
    expect(plan.folders[0].messages).toBe(5000);
    expect(plan.threads).toBe(500);
    expect(plan.folders[0].notes.reduce((s, n) => s + n.messages, 0)).toBe(5000);
    expect(ms).toBeLessThan(120_000);
    console.log(`W5.18: 5,000-message mbox read + planned in ${Math.round(ms)} ms`);
  });
});

describe("W5.18 Google Takeout", () => {
  it("Keep notes (text, checklist, labels, attachment, trash left out), Drive docs and the Takeout mbox", async () => {
    const keep = (title: string, extra: object) =>
      JSON.stringify({ color: "DEFAULT", isTrashed: false, isPinned: false, isArchived: false, title, userEditedTimestampUsec: 1794477600000000, createdTimestampUsec: 1794477600000000, ...extra });
    const z = await zip([
      { name: "Takeout/Keep/קניות.json", data: keep("קניות", { listContent: [{ text: "חלב", isChecked: true }, { text: "לחם", isChecked: false }], labels: [{ name: "בית" }], attachments: [{ filePath: "1a2b.jpg", mimetype: "image/jpeg" }] }) },
      { name: "Takeout/Keep/קניות.html", data: "<html></html>" },
      { name: "Takeout/Keep/1a2b.jpg", data: new Uint8Array([1, 2, 3]) },
      { name: "Takeout/Keep/רעיון.json", data: keep("", { textContent: "רעיון לפרויקט\nשורה שנייה", annotations: [{ title: "מקור", url: "https://example.com/a" }] }) },
      { name: "Takeout/Keep/ישן.json", data: keep("ישן", { textContent: "x", isTrashed: true }) },
      { name: "Takeout/Drive/My Drive/תוכנית.docx", data: new Uint8Array([0x50, 0x4b, 9]) },
      { name: "Takeout/Drive/My Drive/photo.png", data: new Uint8Array([7]) },
      { name: "Takeout/Mail/All mail Including Spam and Trash.mbox", data: "From x@y Thu Nov 12 14:03:00 2026\nSubject: hi\nMessage-ID: <z@x>\n\nhello\n" },
    ]);
    const read = await readMailFiles([{ name: "takeout-20261112.zip", bytes: z }], unzip);
    expect([read.messages.length, read.keep.length, read.docs.length, read.drive.length]).toEqual([1, 3, 1, 1]);
    const plan = await planMailImport(read, opts);
    expect(plan.trashed).toBe(1);
    const keepFolder = plan.folders.find((f) => f.folder === "Google Keep")!;
    expect(keepFolder.notes.map((n) => n.path)).toEqual(["קניות.md", "רעיון לפרויקט.md"]);
    expect(keepFolder.notes[0].content).toBe(
      '---\nsource: "google-keep"\ncreated: "2026-11-12T10:00:00.000Z"\nedited: "2026-11-12T10:00:00.000Z"\ntags: ["בית"]\n---\n\n# קניות\n\n- [x] חלב\n- [ ] לחם\n\n![1a2b.jpg](attachments/1a2b.jpg)\n',
    );
    expect(keepFolder.notes[1].content).toContain("- [מקור](https://example.com/a)");
    expect(keepFolder.attachments.map((a) => a.path)).toEqual(["attachments/1a2b.jpg"]);
    const docs = plan.folders.find((f) => f.folder === "Google Docs")!;
    expect(docs.notes.map((n) => [n.path, n.content])).toEqual([["My Drive/תוכנית.md", "# תוכנית.docx\n\nconverted\n"]]);
    expect(docs.attachments.map((a) => a.path)).toEqual(["My Drive/photo.png"]);
    expect(plan.folders.find((f) => f.folder === "Mail")!.notes[0].content).toContain("hello");
  });
});
