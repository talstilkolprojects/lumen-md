/**
 * Plan W5.11, part 2: what is marked <redact> is removed from every export
 * (not covered), with hidden comments and photo metadata. The DOCX check
 * unzips the real exporter's output and greps its XML.
 */
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "./fixtures/gps-photos.json";
import {
  cleanInlineImages,
  hasRedactions,
  inlineVaultImages,
  prepareForExport,
  REDACTED,
  redactedPassages,
  removeHiddenComments,
  removeRedacted,
  wrapRedaction,
} from "../lib/redaction";
import { hasGps, KEEP_METADATA_KEY } from "../lib/imageMetadata";
import { markdownToDocxBytes } from "../storage/exportDocx";
import { markdownToRtf, markdownToLatex } from "../storage/exportFormats";
import { buildSite } from "../publish/site";
import { convert, convertBinary } from "../cli/convert";

const photos = Object.values((fixtures as { images: Record<string, string> }).images);
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

afterEach(() => localStorage.removeItem(KEEP_METADATA_KEY));

/** The source names, places and numbers a reporter would protect. */
const SECRETS = ["Dana Levi", "דנה לוי", "054-1234567", "Herzl 12, Haifa", "רחוב הרצל 12", "source@example.com", "ID 012345678", "Yossi Cohen", "יוסי כהן", "the leak came from finance"];

/** A note with each secret marked, in prose, a list, a table, a link, a heading, code and a footnote. */
function note(): string {
  const r = (s: string) => wrapRedaction(s);
  return [
    "---",
    "title: Investigation",
    "---",
    `# Meeting with ${r(SECRETS[0])}`,
    "",
    `פגשתי את ${r(SECRETS[1])} ליד ${r(SECRETS[4])}. הטלפון: ${r(SECRETS[2])}.`,
    "",
    `- Address: ${r(SECRETS[3])}`,
    `- Mail: [write](mailto:${r(SECRETS[5])})`,
    "",
    "| who | id |",
    "| --- | --- |",
    `| ${r(SECRETS[7])} | ${r(SECRETS[6])} |`,
    "",
    "```text",
    `contact ${r(SECRETS[8])}`,
    "```",
    "",
    `<redact>\nWhole paragraph: ${SECRETS[9]}.\n</redact>`,
    "",
    "Public text stays.",
  ].join("\n");
}

const unzipText = async (zip: Uint8Array): Promise<string> => {
  // Stored or deflated entries: read the local headers and inflate each part.
  let out = "";
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let at = 0;
  while (at + 30 <= zip.length && dv.getUint32(at, true) === 0x04034b50) {
    const method = dv.getUint16(at + 8, true);
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extra = dv.getUint16(at + 28, true);
    const start = at + 30 + nameLen + extra;
    const data = zip.subarray(start, start + size);
    if (method === 0) out += new TextDecoder().decode(data);
    else {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out += await new Response(stream).text();
    }
    at = start + size;
  }
  return out;
};

describe("removeRedacted", () => {
  it("removes every marked passage and keeps the rest", () => {
    const { text, count } = removeRedacted(note());
    expect(count).toBe(10);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).toContain("Public text stays.");
    expect(text).toContain(`# Meeting with ${REDACTED}`);
    expect(text).not.toMatch(/redact/i);
  });

  it("the placeholder has one length whatever was removed", () => {
    expect(removeRedacted(wrapRedaction("a")).text).toBe(removeRedacted(wrapRedaction("a much longer name")).text);
  });

  it("an unclosed mark removes everything after it (fails closed)", () => {
    expect(removeRedacted("safe <redact>secret\n\nmore secret").text).toBe(`safe ${REDACTED}`);
  });

  it("nested marks: the outermost pair wins; a stray close is dropped", () => {
    expect(removeRedacted("a <redact>b <REDACT>c</redact> d</redact> e").text).toBe(`a ${REDACTED} e`);
    expect(removeRedacted("a </redact> b").text).toBe("a  b");
  });

  it("lists the passages for review and finds marks in any case", () => {
    expect(redactedPassages("x <redact>one</redact> y <Redact >two")).toEqual(["one", "two"]);
    expect(hasRedactions("plain")).toBe(false);
    expect(hasRedactions("a <REDACT>b</REDACT>")).toBe(true);
  });
});

describe("removeHiddenComments", () => {
  it("drops HTML and Obsidian comments outside code, keeps them in code", () => {
    const md = "a <!-- the source is Dana --> b %%call Yossi%% c\n\n```\n<!-- code -->\nprintf(\"%%d\")\n```\n`%%inline%%` d";
    const out = removeHiddenComments(md);
    expect(out).not.toContain("Dana");
    expect(out).not.toContain("Yossi");
    expect(out).toContain("<!-- code -->");
    expect(out).toContain('printf("%%d")');
    expect(out).toContain("`%%inline%%`");
  });

  it("an unclosed HTML comment runs to the end; a lone %% stays text", () => {
    expect(removeHiddenComments("a <!-- secret\nmore")).toBe("a ");
    expect(removeHiddenComments("50%% off")).toBe("50%% off");
  });
});

describe("photos in exports", () => {
  it("data: URL photos lose GPS; keeping metadata leaves them as they are", async () => {
    const typed = photos.map((b64) => {
      const b = bytesOf(b64);
      const type = b[0] === 0xff ? "jpeg" : b[0] === 0x89 ? "png" : "webp";
      return `![](data:image/${type};base64,${b64})`;
    }).join("\n");
    const { text, cleaned } = cleanInlineImages(typed);
    expect(cleaned).toBe(photos.length);
    const left = [...text.matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => bytesOf(m[1]));
    expect(left.filter(hasGps)).toHaveLength(0);

    localStorage.setItem(KEEP_METADATA_KEY, "1");
    expect((await prepareForExport(typed)).text).toBe(typed);
  });

  it("vault photos are inlined clean for PDF and HTML", async () => {
    const jpeg = photos.map(bytesOf).find((b) => b[0] === 0xff) as Uint8Array;
    const md = "![a](lumen-asset-x1.jpg) and ![[lumen-asset-x1.jpg|200]] and ![gone](lumen-asset-missing.png)";
    const read = async (name: string) => {
      if (name !== "lumen-asset-x1.jpg") throw new Error("not found");
      return new Blob([jpeg as BlobPart], { type: "image/jpeg" });
    };
    const { text, inlined } = await inlineVaultImages(md, read);
    expect(inlined).toBe(2);
    expect(text).toContain("![gone](lumen-asset-missing.png)");
    const urls = [...text.matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => bytesOf(m[1]));
    expect(urls).toHaveLength(2);
    expect(urls.filter(hasGps)).toHaveLength(0);
    expect(hasGps(jpeg)).toBe(true);
  });
});

describe("exports carry no redacted text", () => {
  it("DOCX: 0 secrets in any part of the package", async () => {
    const { text } = await prepareForExport(note());
    const xml = await unzipText(await markdownToDocxBytes(text));
    expect(xml).toContain("Public text stays.");
    for (const s of SECRETS) expect(xml).not.toContain(s);
    // And without the export door, the same note does leak: the check is real.
    const raw = await unzipText(await markdownToDocxBytes(note()));
    expect(SECRETS.some((s) => raw.includes(s))).toBe(true);
  });

  it("Markdown, RTF and LaTeX: 0 secrets", async () => {
    const { text, report } = await prepareForExport(note());
    expect(report.redacted).toBe(10);
    for (const out of [text, markdownToRtf(text), markdownToLatex(text)]) for (const s of SECRETS) expect(out).not.toContain(s);
  });
});

describe("every other door out (review 12.11)", () => {
  // Any renderer shows the point; images become <img src> so the site copies them.
  const render = async (md: string) => `<!doctype html><html dir="ltr"><body><main>${md.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '<img src="$1">')}</main></body></html>`;
  const gpsJpeg = () => bytesOf(photos.find((b64) => bytesOf(b64)[0] === 0xff)!);

  it("Publish site: no secret in a page, a title or the search index; photos copied clean, an uncleanable one left out", async () => {
    const md = `${note()}\n![a](a.jpg) ![b](b.jpg)\n`;
    const broken = gpsJpeg().subarray(0, 40);
    const site = await buildSite([{ path: "story.md", content: md }], {
      title: "Notes",
      lang: "en",
      render,
      readAsset: async (p) => (p === "a.jpg" ? gpsJpeg() : p === "b.jpg" ? broken : null),
    });
    const text = site.files.map((f) => (typeof f.data === "string" ? f.data : new TextDecoder("latin1").decode(f.data))).join("\n");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).toContain("Public text stays.");
    const a = site.files.find((f) => f.path === "a.jpg");
    expect(a).toBeDefined();
    expect(hasGps(a!.data as Uint8Array)).toBe(false);
    expect(site.files.some((f) => f.path === "b.jpg")).toBe(false);
    expect(site.withheld).toEqual(["b.jpg"]);
  });

  it("lumen convert (text and binary): 0 secrets; imports are not touched", async () => {
    for (const to of ["tex", "rst", "org", "adoc", "rtf", "opml", "ipynb"]) {
      const { outText } = convert("n.md", note(), to);
      for (const s of SECRETS) expect(outText, to).not.toContain(s);
    }
    const { bytes } = await convertBinary("n.md", note(), "docx");
    const xml = await unzipText(bytes);
    for (const s of SECRETS) expect(xml).not.toContain(s);
    expect(convert("n.csv", "a,b\n<redact>x</redact>,2\n").outText).toContain("<redact>x</redact>");
  });

  it("an inline photo that can't be parsed is withheld, never exported as it was", async () => {
    const cut = gpsJpeg().subarray(0, 40);
    const md = `![x](data:image/jpeg;base64,${btoa(String.fromCharCode(...cut))})`;
    const { text, report } = await prepareForExport(md);
    expect(text).not.toContain(btoa(String.fromCharCode(...cut)).slice(0, 30));
    expect(report.imagesWithheld).toBe(1);
    expect(cleanInlineImages(md).withheld).toBe(1);
  });
});
