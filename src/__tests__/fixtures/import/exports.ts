/**
 * Golden exports for the import wizard (plan W1.26): one per source, in
 * the shape each tool writes (its documented export format), with Hebrew
 * names, dates, tags, attachments and internal links — and the traps each
 * tool sets (Notion's ids and `_all.csv`, Keep's .jpeg/.jpg, Logseq's
 * `___` namespaces and lower-case file names, Evernote's MD5 media).
 *
 * They are written from the formats' documentation, not exported by the
 * tools themselves: Tal replaces them with real exports (plan dodMock).
 */
import { zip } from "../../../storage/zip";
import { md5Hex } from "../../../storage/import/md5";

const enc = new TextEncoder();
const b = (s: string) => enc.encode(s);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A 1×1 PNG, and a second one that differs (so their MD5s do). */
export const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
export const PNG2 = Uint8Array.from([...PNG.slice(0, -1), 0x83]);
export const PDF = b("%PDF-1.4\n% fake\n%%EOF\n");

const id = (n: number) => n.toString(16).padStart(2, "0").repeat(16);

async function zipped(name: string, files: Record<string, Uint8Array | string>): Promise<Map<string, Uint8Array>> {
  const bytes = await zip(Object.entries(files).map(([k, v]) => ({ name: k, data: typeof v === "string" ? b(v) : v })));
  return new Map([[name, bytes]]);
}

/* ─── Obsidian ──────────────────────────────────────────────────────── */

export function obsidianVault(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["כספת/.obsidian/app.json", b("{}")],
    ["כספת/.obsidian/workspace.json", b("{}")],
    ["כספת/בית.md", b("---\ntags: [home]\n---\n# בית\n\nראו [[פרויקטים/תוכנית]] ו-[[תוכנית|התוכנית]], ![[תמונה.png]] ו-[מסמך](פרויקטים/תוכנית.md).\n\n![[ספרים.base]]\n")],
    ["כספת/פרויקטים/תוכנית.md", b("# תוכנית\n\nחזרה ל[[בית]]. `[[לא קישור]]`\n")],
    ["כספת/attachments/תמונה.png", PNG],
    ["כספת/ספרים.base", b('filters: file.hasTag("book")\nviews:\n  - type: table\n    name: ספרים\n')],
  ]);
}

/* ─── Notion (Markdown & CSV, zipped twice as Notion does) ──────────── */

export const NOTION_COLUMNS = ["Name", "Author", "Pages", "Read", "Published", "Tags"];

export async function notionExport(): Promise<Map<string, Uint8Array>> {
  const H = `בית ${id(1)}`;
  const P = `Project Alpha ${id(2)}`;
  const B = `ספרים ${id(3)}`;
  const R1 = `שלום עולם ${id(4)}`;
  const R2 = `Dune ${id(5)}`;
  const csv = [
    NOTION_COLUMNS.join(","),
    'שלום עולם,עמוס עוז,320,Yes,"January 31, 2024","novel, hebrew"',
    'Dune,Frank Herbert,412,No,"August 1, 1965",scifi',
    "Empty row,,,No,,",
  ].join("\n");
  const inner = await zip(
    Object.entries({
      [`${H}.md`]: `# בית\n\nהספרייה: [ספרים](${encodeURI(`${B}.csv`)})\n\nהפרויקט: [Project Alpha](${encodeURI(`${H}/${P}.md`)})\n\n![](${encodeURI(`${H}/diagram.png`)})\n\n[Notion](https://www.notion.so/x)\n`,
      [`${H}/${P}.md`]: `# Project Alpha\n\nBack [home](${encodeURI(`../${H}.md`)}). The [first book](${encodeURI(`../${B}/${R1}.md`)}#${id(9)}).\n`,
      [`${H}/diagram.png`]: PNG,
      [`${B}.csv`]: "\u{feff}" + csv.split("\n").slice(0, 3).join("\n"),
      [`${B}_all.csv`]: "\u{feff}" + csv,
      [`${B}/${R1}.md`]: `# שלום עולם\n\nAuthor: עמוס עוז\nPages: 320\nRead: Yes\nPublished: January 31, 2024\nTags: novel, hebrew\n\nתקציר קצר.\n`,
      [`${B}/${R2}.md`]: `# Dune\n\nAuthor: Frank Herbert\nPages: 412\n\n![](${encodeURI(`${R2}/cover.jpg`)})\n\nSee [home](${encodeURI(`../${H}.md`)}).\n`,
      [`${B}/${R2}/cover.jpg`]: PNG2,
    }).map(([name, v]) => ({ name, data: typeof v === "string" ? b(v) : v })),
  );
  return zipped("Export-7a1b.zip", { "Export-7a1b-Part-1.zip": inner });
}

/* ─── Evernote (.enex) ──────────────────────────────────────────────── */

export function evernoteExport(): Map<string, Uint8Array> {
  const enml = (body: string) => `<![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${body}</en-note>]]>`;
  return new Map([
    [
      "מחברת עבודה.enex",
      b(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20240201T090000Z" application="Evernote" version="10.0">
<note><title>פגישת צוות &amp; תכנון</title><created>20240131T101500Z</created><updated>20240131T113000Z</updated><tag>עבודה</tag><tag>weekly sync</tag>
<note-attributes><author>טל</author><source-url>https://example.com/meeting</source-url></note-attributes>
<content>${enml(`<div><b>סדר יום</b></div><div><en-todo checked="true"/>לסגור גרסה</div><div><en-todo/>לכתוב מסמך</div><div><en-media hash="${md5Hex(PNG)}" type="image/png"/></div><div>ראו <a href="evernote:///view/1/s1/abc/abc/">רשימה</a>.</div>`)}</content>
<resource><data encoding="base64">${b64(PNG)}</data><mime>image/png</mime><resource-attributes><file-name>לוח.png</file-name></resource-attributes></resource>
</note>
<note><title>רשימה</title><created>20240101T080000Z</created><updated>20240102T080000Z</updated>
<content>${enml(`<div>שורה ראשונה</div><en-crypt hint="pw">AAAA</en-crypt><div>חזרה ל<a href="https://www.evernote.com/shard/s1/nl/1/abc/">פגישת צוות &amp; תכנון</a></div>`)}</content>
<resource><data encoding="base64">${b64(PDF)}</data><mime>application/pdf</mime><resource-attributes><file-name>דוח (סופי).pdf</file-name></resource-attributes></resource>
</note>
</en-export>`),
    ],
  ]);
}

/* ─── Bear (.bearbk: zipped TextBundles) ────────────────────────────── */

export async function bearExport(): Promise<Map<string, Uint8Array>> {
  const info = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "net.daringfireball.markdown", version: 2, "net.shinyfrog.bear": { creationDate: "2024-01-10T08:00:00Z", modificationDate: "2024-01-12T09:30:00Z", ...extra } });
  return zipped("Bear Notes.bearbk", {
    "רשימת קניות.textbundle/text.md": "# רשימת קניות\n\n- [ ] חלב\n- [x] לחם\n\n![](assets/photo%201.png)\n\n#בית/מטבח\n",
    "רשימת קניות.textbundle/info.json": info({ pinned: 1 }),
    "רשימת קניות.textbundle/assets/photo 1.png": PNG,
    "Ideas.textbundle/text.markdown": "# Ideas\n\n::important:: see [[רשימת קניות]] and `::code::`\n\n#multi word tag# and #simple\n",
    "Ideas.textbundle/info.json": info(),
    "Ideas.textbundle/assets/sketch.pdf": PDF,
    "Old.textbundle/text.md": "# Old\n\ngone\n",
    "Old.textbundle/info.json": info({ trashed: 1 }),
  });
}

/* ─── Apple Notes (an exporter's HTML folder) ───────────────────────── */

export function appleNotesExport(): Map<string, Uint8Array> {
  return new Map([
    [
      "Notes/iCloud/מתכון.html",
      b(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>מתכון עוגה</title><meta name="created" content="2023-12-01T10:00:00Z"><meta name="modified" content="2023-12-05T18:20:00Z"></head><body><h1>מתכון עוגה</h1><p>שלוש ביצים.</p><img src="data:image/png;base64,${b64(PNG)}" alt="עוגה"><p>ראו <a href="Shopping.html">קניות</a></p></body></html>`),
    ],
    [
      "Notes/iCloud/Shopping.html",
      b(`<html><head><title>Shopping</title><meta name="created" content="2023-11-01T10:00:00Z"></head><body><ul><li><input type="checkbox" checked>Milk</li><li><input type="checkbox">Eggs</li></ul><img src="Shopping_files/list.png"><p><a href="${encodeURI("מתכון.html")}">המתכון</a></p></body></html>`),
    ],
    ["Notes/iCloud/Shopping_files/list.png", PNG2],
    ["Notes/iCloud/.DS_Store", b("x")],
  ]);
}

/* ─── Google Keep (Takeout) ─────────────────────────────────────────── */

export async function keepExport(): Promise<Map<string, Uint8Array>> {
  const note = (o: Record<string, unknown>) => JSON.stringify({ color: "DEFAULT", isTrashed: false, isPinned: false, isArchived: false, createdTimestampUsec: 1706695200000000, userEditedTimestampUsec: 1706698800000000, ...o });
  return zipped("takeout-20240201.zip", {
    "Takeout/archive_browser.html": "<html></html>",
    "Takeout/Keep/Labels.txt": "קניות\n",
    "Takeout/Keep/Groceries.json": note({ title: "Groceries", listContent: [{ text: "חלב", isChecked: true }, { text: "Bread", isChecked: false }], labels: [{ name: "קניות" }], attachments: [{ filePath: "photo.jpeg", mimetype: "image/jpeg" }], isPinned: true, color: "YELLOW" }),
    "Takeout/Keep/Groceries.html": "<html>copy</html>",
    "Takeout/Keep/photo.jpg": PNG,
    "Takeout/Keep/רעיון.json": note({ title: "", textContent: "רעיון לסטארטאפ\nעם שתי שורות", isArchived: true, annotations: [{ url: "https://example.com/idea", title: "Idea" }] }),
    "Takeout/Keep/Deleted.json": note({ title: "Deleted", textContent: "x", isTrashed: true, attachments: [{ filePath: "old.png", mimetype: "image/png" }] }),
    "Takeout/Keep/old.png": PNG2,
    "Takeout/Keep/recording.3gp": b("audio"),
  });
}

/* ─── Logseq (graph folder) ─────────────────────────────────────────── */

export const LOGSEQ_UUID = "6512d0f5-7c1e-4b0e-9a7e-3f1c2d4b5a69";

export function logseqGraph(): Map<string, Uint8Array> {
  return new Map([
    ["graph/logseq/config.edn", b("{:meta/version 1}")],
    ["graph/logseq/bak/pages/x.md", b("old")],
    ["graph/pages/Project___Alpha.md", b(`tags:: work, [[urgent]]\nstatus:: active\n\n- TODO write the spec\n  id:: ${LOGSEQ_UUID}\n- DONE kickoff\n- See [[Meeting Notes]] and ![board](../assets/board.png)\n- Planned on [[Jan 31st, 2024]]\n`)],
    ["graph/pages/meeting notes.md", b("- agenda #[[פגישה שבועית]]\n  collapsed:: true\n- {{embed [[project/alpha]]}}\n")],
    ["graph/pages/פגישה שבועית.md", b("title:: פגישה שבועית\n\n- כל יום ראשון\n")],
    ["graph/journals/2024_01_31.md", b(`- worked on [[Project/Alpha]]: ((${LOGSEQ_UUID}))\n- {{embed ((${LOGSEQ_UUID}))}}\n`)],
    ["graph/assets/board.png", PNG],
  ]);
}

/* ─── OneNote (Single File Web Page, .mht) ──────────────────────────── */

/** Quoted-printable as Outlook writes it: UTF-8 bytes as =XX, soft line breaks never inside an escape. */
function qp(s: string): string {
  const tokens = [...enc.encode(s)].map((c) => (c > 126 || c === 61 ? `=${c.toString(16).toUpperCase().padStart(2, "0")}` : String.fromCharCode(c)));
  const lines: string[] = [];
  let line = "";
  for (const tk of tokens) {
    if (line.length + tk.length > 72) {
      lines.push(`${line}=`);
      line = "";
    }
    line += tk;
  }
  lines.push(line);
  return lines.join("\r\n");
}

export function onenoteExport(): Map<string, Uint8Array> {
  const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>סיכום פרויקט</title></head><body><p style="font-size:20pt">סיכום פרויקט</p><p>יום שלישי, 30 בינואר 2024</p><p>הנקודות העיקריות:</p><ul><li>לוח זמנים</li><li>תקציב</li></ul><img src="סיכום_files/image001.png" alt="תרשים"><p><a href="file:///C:/Notes/budget.xlsx">budget.xlsx</a></p></body></html>`;
  const mht = [
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="----=_NextPart_01DA"',
    "",
    "------=_NextPart_01DA",
    "Content-Location: file:///C:/Users/tal/AppData/Local/Temp/סיכום.htm",
    "Content-Transfer-Encoding: quoted-printable",
    'Content-Type: text/html; charset="utf-8"',
    "",
    qp(html),
    "",
    "------=_NextPart_01DA",
    "Content-Location: file:///C:/Users/tal/AppData/Local/Temp/סיכום_files/image001.png",
    "Content-Transfer-Encoding: base64",
    "Content-Type: image/png",
    "",
    b64(PNG),
    "",
    "------=_NextPart_01DA",
    "Content-Location: file:///C:/Users/tal/AppData/Local/Temp/סיכום_files/notes.pdf",
    "Content-Transfer-Encoding: base64",
    "Content-Type: application/pdf",
    "",
    b64(PDF),
    "",
    "------=_NextPart_01DA--",
    "",
  ].join("\r\n");
  return new Map([
    ["סיכום.mht", b(mht)],
    ["Notebook.one", b("binary")],
  ]);
}
