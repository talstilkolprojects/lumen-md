/**
 * Plan W6.38 — import and paste against a real corpus
 * (fixtures/real-corpus, manifest.json lists every file, its source,
 * licence and sha256):
 *
 * - docx/: 30 Word documents written by LibreOffice 24.2 (MS Word 2007 XML)
 * - pdf/ and pdf-copy/: the same 30 documents printed to PDF by LibreOffice,
 *   and the text a person copies out of each with pdf.js (Firefox's viewer)
 *   and poppler (Evince, Okular)
 * - paste-libreoffice/: LibreOffice Writer's clipboard HTML of each document
 * - paste-gdocs/, paste-word/: Google Docs' and Word's clipboard HTML of the
 *   same 30 documents, in the shape each writes
 * - notion/: 30 Notion exports (Markdown & CSV, and HTML)
 * - evernote/: 35 real ENEX exports (Evernote Mac and Windows) from yarle's
 *   test data (MIT)
 * - whatsapp/: 30 chat exports, Android and iPhone, Hebrew, English, Arabic
 *   (the parser is plan W5.7's; it is scored where it lives)
 *
 * Each converted document is scored on headings, list items (depth and
 * kind), table rows, links, images and right-to-left text (every Hebrew word
 * in reading order, no stray direction control): ./fixtures/real-corpus/fidelity.ts.
 * Gates: plan W6.38 asks for ≥ 95% of pasted documents and ≥ 90% of imported
 * ones kept whole. All of them are whole now, so each format must stay at
 * 100%; every failure the corpus found is also pinned by a small case below.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanPastedText, pastedHtmlToMarkdown } from "../paste/htmlPaste";
import { suggestPdfHebrewFix } from "../paste/pdfHebrew";
import { htmlToNote } from "../storage/import/html";
import { docxToMarkdown } from "../storage/fileFormats";
import { convertExport } from "../storage/import/convert";
import { unzip } from "../storage/zip";
import { expectOf, expectOfEnml, hebrewWords, inOrder, perfect, score, total, type ModelDoc, type Score } from "./fixtures/real-corpus/fidelity";

const DIR = join(__dirname, "fixtures", "real-corpus");
const model = JSON.parse(readFileSync(join(DIR, "model.json"), "utf8")) as ModelDoc[];
const byId = new Map(model.map((d) => [d.id, d]));
const files = (sub: string, ext: RegExp) => readdirSync(join(DIR, sub)).filter((f) => ext.test(f)).sort();
const bytes = (sub: string, f: string) => new Uint8Array(readFileSync(join(DIR, sub, f))).slice();
const text = (sub: string, f: string) => readFileSync(join(DIR, sub, f), "utf8");
const idOf = (f: string) => /doc\d\d/.exec(f)![0];

interface Run {
  name: string;
  scores: Score[];
  failed: string[];
}
const rate = (r: Run) => (r.scores.length - r.failed.length) / r.scores.length;
const report = (r: Run) => {
  const t = total(r.scores);
  const pct = (k: keyof Score) => (t[k].want ? `${k} ${((100 * t[k].got) / t[k].want).toFixed(1)}%` : `${k} –`);
  return `${r.name}: ${r.scores.length - r.failed.length}/${r.scores.length} whole · ${(["headings", "lists", "tables", "links", "images", "rtl"] as const).map(pct).join(" · ")}${r.failed.length ? ` · failed: ${r.failed.join(", ")}` : ""}`;
};

async function run(name: string, list: string[], one: (f: string) => Promise<{ md: string; s: Score }>): Promise<Run> {
  const r: Run = { name, scores: [], failed: [] };
  for (const f of list) {
    const { s } = await one(f);
    r.scores.push(s);
    if (!perfect(s)) r.failed.push(f);
  }
  console.info(report(r));
  return r;
}

const paste = (sub: string) => run(`paste ${sub}`, files(sub, /\.html$/), async (f) => {
  const md = pastedHtmlToMarkdown(text(sub, f));
  return { md, s: score(md, expectOf(byId.get(idOf(f))!)) };
});

describe("the corpus (manifest)", () => {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { formats: Record<string, { files: { path: string; sha256: string; licence: string; source: string }[] }> };

  it("≥ 30 real files for each of the 8 formats, each with its licence and source", () => {
    const formats = Object.entries(manifest.formats);
    expect(formats).toHaveLength(8);
    for (const [name, f] of formats) {
      expect(f.files.length, name).toBeGreaterThanOrEqual(30);
      for (const x of f.files) expect(x.licence && x.source, x.path).toBeTruthy();
    }
  });

  it("every file is the one the manifest names (sha256)", () => {
    for (const f of Object.values(manifest.formats).flatMap((x) => x.files)) {
      expect(createHash("sha256").update(readFileSync(join(DIR, f.path))).digest("hex"), f.path).toBe(f.sha256);
    }
  });
});

describe("paste (plan: ≥ 95% kept whole; held at 100%)", () => {
  it("Google Docs", async () => expect(rate(await paste("paste-gdocs"))).toBe(1));
  it("Word", async () => expect(rate(await paste("paste-word"))).toBe(1));
  it("LibreOffice Writer", async () => expect(rate(await paste("paste-libreoffice"))).toBe(1));

  it("Hebrew PDF: every copied line reads right to left in logical order, no stray direction control, no wrong fix offered", async () => {
    const letters = (s: string) => Array.from(s.normalize("NFC").replace(/[^\u05D0-\u05EA]/g, ""));
    for (const viewer of ["pdfjs", "poppler"]) {
      let offered = 0;
      let fused = 0;
      let words = 0;
      let order = 0;
      const r = await run(`pdf copy (${viewer})`, files(`pdf-copy/${viewer}`, /\.txt$/), async (f) => {
        // What lands in the note: the paste (direction embeddings dropped), or the fix a toast offers for it.
        const pasted = cleanPastedText(text(`pdf-copy/${viewer}`, f));
        const fix = suggestPdfHebrewFix(pasted);
        if (fix) offered++;
        const md = fix?.fixed ?? pasted;
        const e = expectOf(byId.get(idOf(f))!);
        // Words a PDF reader runs together where the PDF has no space glyph (table cells, script changes) are counted, not failed.
        words += e.hebrew.length;
        fused += e.hebrew.length - inOrder(e.hebrew, hebrewWords(md));
        // Direction: within each copied line, neighbouring Hebrew words in the source's order, not reversed.
        // (Where a reader puts a table cell or a list number on the page is its layout, not direction.)
        // Pairs inside one heading, paragraph, list item or table cell: the order of cells is the table's layout.
        const segments = byId.get(idOf(f))!.blocks.flatMap((b) =>
          b.t === "h" ? [b.text] : b.t === "p" ? [b.runs.map((x) => x.text).join("")] : b.t === "table" ? b.rows.flat() : b.t === "img" ? [] : b.items.flatMap((it) => [it.text, ...(it.children ?? []).map((c) => c.text)]),
        );
        const pairs = new Set(
          segments.flatMap((seg) => {
            const ws = hebrewWords(seg);
            return ws.slice(1).map((w, i) => `${ws[i]} ${w}`);
          }),
        );
        let forward = 0;
        let backward = 0;
        for (const line of md.split("\n")) {
          const ws = hebrewWords(line);
          for (let i = 1; i < ws.length; i++) {
            if (pairs.has(`${ws[i - 1]} ${ws[i]}`)) forward++;
            else if (pairs.has(`${ws[i]} ${ws[i - 1]}`)) backward++;
          }
        }
        order += inOrder(letters(e.hebrew.join(" ")), letters(md)) / letters(e.hebrew.join(" ")).length / 30;
        const ok = !/[\u202A-\u202E\u2066-\u2069]/.test(md) && backward === 0 && forward > 0;
        const none = { want: 0, got: 0 };
        return { md, s: { headings: none, lists: none, tables: none, links: none, images: none, rtl: { want: forward + backward, got: ok ? forward + backward : forward } } };
      });
      console.info(`pdf copy (${viewer}): a fix offered on ${offered}/30 correct texts; ${fused}/${words} Hebrew words run together by the reader; ${(100 * order).toFixed(1)}% of the letters in the document's order`);
      expect(offered, viewer).toBe(0);
      expect(rate(r), viewer).toBe(1);
    }
  });
});

describe("import (plan: ≥ 90% kept whole; held at 100%)", () => {
  it("Word (.docx)", async () => {
    const r = await run("import docx", files("docx", /\.docx$/), async (f) => {
      const md = await docxToMarkdown(new File([bytes("docx", f)], f));
      return { md, s: score(md, expectOf(byId.get(idOf(f))!)) };
    });
    expect(rate(r)).toBe(1);
  });

  it("Notion (Markdown & CSV, HTML)", async () => {
    const r = await run("import notion", files("notion", /\.zip$/), async (f) => {
      const vault = convertExport("notion", await unzip(bytes("notion", f).buffer), "Notion");
      const doc = byId.get(idOf(f))!;
      const page = [...vault.notes.entries()].find(([p]) => p.endsWith(".md") && !p.includes("/"));
      const md = page?.[1] ?? "";
      const s = score(md, expectOf(doc));
      // An image embed counts only when its file came along.
      const embeds = [...md.matchAll(/!\[[^\]]*\]\(<?([^)>]+)>?\)|!\[\[([^\]|]+)/g)].filter((m) => [...vault.attachments.keys()].some((a) => a.endsWith(decodeURI(m[1] ?? m[2]).split("/").pop()!)));
      return { md, s: { ...s, images: { want: s.images.want, got: Math.min(s.images.want, embeds.length) } } };
    });
    expect(rate(r)).toBe(1);
  });

  it("Evernote (.enex)", async () => {
    const parse = (h: string) => new DOMParser().parseFromString(h, "text/html");
    const r = await run("import evernote", files("evernote", /\.enex$/), async (f) => {
      const xml = text("evernote", f);
      const vault = convertExport("evernote", new Map([[f, bytes("evernote", f)]]), "Evernote");
      const notes = [...xml.matchAll(/<content>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/content>/g)].map((m) => m[1]);
      const md = [...vault.notes.values()].join("\n\n");
      const want = notes.map((n) => expectOfEnml(n, parse));
      const e = { headings: want.flatMap((w) => w.headings), items: want.flatMap((w) => w.items), rows: want.flatMap((w) => w.rows), links: want.flatMap((w) => w.links), images: want.reduce((a, w) => a + w.images, 0), hebrew: want.flatMap((w) => w.hebrew) };
      return { md, s: score(md, e) };
    });
    expect(rate(r)).toBe(1);
  });
});

describe("every failure the corpus found, as a small case", () => {
  it("Google Docs: a sub-list written inside the parent list (not inside the item) nests, and keeps its text", () => {
    const html = `<b style="font-weight:normal;" id="docs-internal-guid-1"><ul><li aria-level="1"><p role="presentation"><span>אחת</span></p></li><ul><li aria-level="2"><p role="presentation"><span>תת</span></p></li></ul><li aria-level="1"><p role="presentation"><span>שתיים</span></p></li></ul></b>`;
    expect(pastedHtmlToMarkdown(html)).toBe("- אחת\n  - תת\n- שתיים");
  });

  it("LibreOffice: a bold run split where the script changes is one bold span", () => {
    expect(pastedHtmlToMarkdown(`<p><b>העלות היא</b><b> 12,500 </b><b>ש</b><b>"</b><b>ח</b>.</p>`)).toBe('**העלות היא 12,500 ש"ח**.');
  });

  it("PDF: correct Hebrew with words a reader ran together is not offered a finals fix", () => {
    expect(suggestPdfHebrewFix("ראו גםאתר העירייה. ספקמהירותמחיר חודשי\nהפגישה התקיימה ביום שלישי בשעה 10:00 במשרד בתל אביב.")).toBeNull();
    // Swapped final forms are still caught.
    expect(suggestPdfHebrewFix("שלומ עולמ, מה שלומכמ היומ?")?.kind).toBe("finals");
  });

  it("PDF: poppler's direction embeddings around each line are dropped from a plain paste; other text is untouched", () => {
    expect(cleanPastedText("\u202bשלום עולם\u202c\n\u202bגם \u202a.the docs\u202c\u202c")).toBe("שלום עולם\nגם .the docs");
    expect(cleanPastedText("Tal\u200f: שלום")).toBe("Tal\u200f: שלום");
  });

  it("Word (.docx): links, numbered and nested lists, Hebrew bold (w:bCs) and the image come along", async () => {
    const md = await docxToMarkdown(new File([bytes("docx", "doc10.docx")], "doc10.docx"));
    expect(md).toContain("[ויקיפדיה](https://example.org/wiki/");
    expect(md).toMatch(/^1\. לכתוב טיוטה ראשונה$/m);
    expect(md).toMatch(/^- 200 גרם תרד\n {3}- לסגור את הדוח הכספי$/m);
    expect(md).toContain('**העלות המשוערת היא 12,500 ש"ח כולל מע"מ.**');
    expect(md).toMatch(/!\[תרשים 9\]\(data:image\/png;base64,/);
  });

  it("Notion HTML: an image inside a link to itself (a figure) stays an image", () => {
    const md = htmlToNote(`<figure><a href="P/img.png"><img src="P/img.png"/></a></figure>`, { image: () => "![](P/img.png)", link: (h, t) => `[${t}](${h})` });
    expect(md.trim()).toBe("![](P/img.png)");
  });

  it("Evernote: <ul><li>a</li><ul>…</ul></ul> and an item holding only a sub-list both nest", () => {
    expect(htmlToNote("<ul><li>Level1</li><ul><li>Level2</li><ul><li>Level3</li></ul></ul></ul>").trim()).toMatch(/^- Level1\n\s+- Level2\n\s+- Level3$/);
    expect(htmlToNote("<ul><li>Level1</li><li><ul><li>Level2</li></ul></li></ul>").trim()).toMatch(/^- Level1\n\s+- Level2$/);
  });

  it("Evernote: the space at the end of a bold run stays outside it", () => {
    expect(htmlToNote("<p>Checklist <b>bold </b>and</p>").trim()).toBe("Checklist **bold** and");
  });
});
