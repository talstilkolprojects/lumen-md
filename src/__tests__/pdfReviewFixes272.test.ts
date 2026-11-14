/**
 * Review #272, coordinator decisions 2.17, 2.19, 2.20, 2.22, 2.23, 2.24 and
 * 2.26 (plan 4.14): binaries stay out of the text indexes, a PDF can't be
 * renamed onto its own highlights note, edge whitespace survives a generated
 * link, the managed region is the marker pair around the annotations fence,
 * the highlights list stays reachable on a phone, an encoded link opens the
 * file it was made for, and a malformed annotation makes the block
 * unreadable instead of crashing the reader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import * as ws from "../storage/workspace";
import { __resetWorkspaceIndex, ensureIndex, indexedFiles } from "../storage/workspaceIndex";
import { isIndexableTextPath } from "../lib/textPaths";
import { decodeWikiPath, encodeWikiPath, hasWikiPathEscape } from "../lib/wikiPath";
import { resolveWikiTarget, splitWikiTarget } from "../renderer/wikiLinks";
import { rewriteLinks } from "../storage/linkRewrite";
import { CompanionPathError, safeMoveWithCompanion } from "../storage/fileOps";
import { listTrash } from "../storage/trash";
import {
  NOTE_END,
  NOTE_START,
  createPdfAnnotation,
  findManagedRegion,
  highlightLinkTarget,
  parseAnnotationsNote,
  readAnnotationsNote,
  upsertAnnotationsNote,
  type PdfAnnotation,
} from "../pdf/annotations";

const labels = { title: "Highlights — paper.pdf", page: (n: number) => `p. ${n}`, empty: "none" };
const ann = (id = "123e4567-e89b-42d3-a456-426614174000", source = "paper.pdf") =>
  createPdfAnnotation({ id, source, page: 2, text: "alpha two", start: 0, end: 5, now: new Date("2026-11-14T00:00:00Z") });

beforeEach(() => {
  installFakeOpfs();
  __resetWorkspaceIndex();
});
afterEach(() => vi.restoreAllMocks());

describe("2.17: the text indexes take notes and plain text only", () => {
  it("knows the note and plain-text extensions, and nothing binary", () => {
    for (const p of ["a.md", "b/c.MARKDOWN", "notes.txt", "x.mdx", "paper.pdf.md", "doc.rst", "d.org"]) expect(isIndexableTextPath(p)).toBe(true);
    for (const p of ["paper.pdf", "img.png", "a.zip", "song.mp3", "x.docx", "README", "a.md.pdf"]) expect(isIndexableTextPath(p)).toBe(false);
  });

  it("the workspace index skips an imported PDF but keeps its highlights note", async () => {
    await ws.writeWorkspaceFile("a.md", "hello");
    await ws.writeWorkspaceBlob("paper.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80]));
    await ws.writeWorkspaceFile("paper.pdf.md", "highlights");
    await ensureIndex();
    expect(indexedFiles().map((f) => f.path).sort()).toEqual(["a.md", "paper.pdf.md"]);
  });

  it("an announced change to a PDF doesn't pull it into the index either", async () => {
    await ws.writeWorkspaceFile("a.md", "hello");
    await ensureIndex();
    await ws.writeWorkspaceBlob("paper.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const { notifyWorkspaceChanged } = await import("../storage/workspaceEvents");
    notifyWorkspaceChanged({ kind: "content", paths: ["paper.pdf", "a.md"] });
    await ensureIndex();
    expect(indexedFiles().map((f) => f.path)).toEqual(["a.md"]);
  });

  it("the BM25 worker is built without the PDF", async () => {
    await ws.writeWorkspaceFile("a.md", "alpha bravo charlie delta");
    await ws.writeWorkspaceFile("b.txt", "echo foxtrot golf hotel");
    await ws.writeWorkspaceBlob("paper.pdf", new TextEncoder().encode("%PDF-1.7 lots of binary-looking text here"));
    const posted: { type: string; docs?: { path: string }[] }[] = [];
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      postMessage(msg: { type: string; docs?: { path: string }[] }) {
        posted.push(msg);
        if (msg.type === "BUILD") queueMicrotask(() => this.onmessage?.({ data: { type: "BUILT", success: true, docCount: 2 } }));
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    const { buildRagIndex } = await import("../ai/embeddings");
    void buildRagIndex();
    await vi.waitFor(() => expect(posted.some((m) => m.type === "BUILD")).toBe(true));
    const build = posted.find((m) => m.type === "BUILD")!;
    expect(build.docs!.map((d) => d.path).sort()).toEqual(["a.md", "b.txt"]);
    vi.unstubAllGlobals();
  });
});

describe("2.19: a PDF can't be renamed onto its own highlights note", () => {
  it("refuses paper.pdf → paper.pdf.md before anything moves", async () => {
    await ws.writeWorkspaceFile("paper.pdf", "%PDF");
    await ws.writeWorkspaceFile("paper.pdf.md", "my highlights");
    const confirmReplace = vi.fn(async () => true);
    await expect(safeMoveWithCompanion("paper.pdf", "paper.pdf.md", { confirmReplace })).rejects.toBeInstanceOf(CompanionPathError);
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(await ws.readWorkspaceFile("paper.pdf")).toBe("%PDF");
    expect(await ws.readWorkspaceFile("paper.pdf.md")).toBe("my highlights");
    expect(await ws.workspaceHasEntry("paper.pdf.md.md")).toBe(false);
    expect(await listTrash()).toEqual([]);
  });

  it("refuses it whatever the letter case, and with no note yet", async () => {
    await ws.writeWorkspaceFile("a/Paper.PDF", "%PDF");
    await expect(safeMoveWithCompanion("a/Paper.PDF", "a/paper.pdf.MD")).rejects.toThrow(/highlights note/);
    expect(await ws.readWorkspaceFile("a/Paper.PDF")).toBe("%PDF");
  });

  it("refuses the note taking its PDF's name, but not other renames", async () => {
    await ws.writeWorkspaceFile("paper.pdf", "%PDF");
    await ws.writeWorkspaceFile("paper.pdf.md", "my highlights");
    await expect(safeMoveWithCompanion("paper.pdf.md", "paper.pdf", { confirmReplace: async () => true })).rejects.toBeInstanceOf(CompanionPathError);
    expect(await ws.readWorkspaceFile("paper.pdf")).toBe("%PDF");
    expect(await listTrash()).toEqual([]);
    // A note renamed to a bare name (a.md → a) is an ordinary rename.
    await ws.writeWorkspaceFile("a.md", "x");
    expect((await safeMoveWithCompanion("a.md", "a"))?.main.path).toBe("a");
    // The pair still moves together to a new name.
    expect((await safeMoveWithCompanion("paper.pdf", "draft.pdf"))?.companion?.path).toBe("draft.pdf.md");
  });
});

describe("2.20: whitespace at the ends of a generated wiki path", () => {
  it("is encoded and decoded back; inner spaces stay as written", () => {
    expect(encodeWikiPath(" paper.pdf")).toBe("%20paper.pdf");
    expect(encodeWikiPath("my paper .pdf ")).toBe("my paper .pdf%20");
    expect(encodeWikiPath("\tx ")).toBe("%09x%C2%A0");
    for (const p of [" paper.pdf", "  a b  ", "x% ", "%20literal", "a#b |c] ", "　wide.pdf"]) {
      expect(decodeWikiPath(encodeWikiPath(p))).toBe(p);
    }
    // A literal "%20" in a name is %25-escaped, so it never becomes a space.
    expect(encodeWikiPath("%20.pdf")).toBe("%2520.pdf");
    // Only at the ends: an encoded space inside a hand-written link stays.
    expect(decodeWikiPath("a%20b")).toBe("a%20b");
    expect(hasWikiPathEscape("plain name.pdf")).toBe(false);
    expect(hasWikiPathEscape("%20x.pdf")).toBe(true);
  });

  it("a highlight link of ' paper.pdf' survives the wiki parser and opens that file", () => {
    const target = highlightLinkTarget(" paper.pdf", ann("123e4567-e89b-42d3-a456-426614174000", " paper.pdf"));
    expect(target.startsWith("%20paper.pdf#")).toBe(true);
    const { note } = splitWikiTarget(target);
    expect(resolveWikiTarget(note, ["paper.pdf", " paper.pdf"])).toBe(" paper.pdf");
  });

  it("a moved PDF with edge whitespace gets its links rewritten encoded", () => {
    expect(rewriteLinks("[[%20paper.pdf#page=1|p. 1]]", "x.md", " paper.pdf", "draft .pdf ")).toBe("[[draft .pdf%20#page=1|p. 1]]");
  });
});

describe("2.24: an encoded link resolves to the file it was made for", () => {
  it("prefers the decoded target over a file literally named with the escape", () => {
    const paths = ["draft%232.pdf", "draft#2.pdf"];
    expect(resolveWikiTarget(encodeWikiPath("draft#2.pdf"), paths)).toBe("draft#2.pdf");
    // Same with the other order in the listing.
    expect(resolveWikiTarget("draft%232.pdf", [...paths].reverse())).toBe("draft#2.pdf");
  });

  it("falls back to the raw target when nothing has the decoded name", () => {
    expect(resolveWikiTarget("draft%232.pdf", ["draft%232.pdf"])).toBe("draft%232.pdf");
    expect(resolveWikiTarget("100%25.pdf", ["100%.pdf"])).toBe("100%.pdf");
    // Unescaped targets resolve as before.
    expect(resolveWikiTarget("paper.pdf", ["paper.pdf.md", "paper.pdf"])).toBe("paper.pdf");
    expect(resolveWikiTarget(" Note ", ["Note.md"])).toBe("Note.md");
  });
});

describe("2.22: the managed region is the marker pair around the annotations fence", () => {
  it("leaves a marker quoted in the user's own text alone", () => {
    const user = `# Paper\n\nThe block starts with ${NOTE_START} and my text goes on here.\n\nMore of my notes.\n`;
    const once = upsertAnnotationsNote(user, "paper.pdf", [ann()], labels);
    expect(once.startsWith(user.trimEnd())).toBe(true);
    expect(readAnnotationsNote(once)).toHaveLength(1);
    // Saving again replaces only the real block, after the quote.
    const twice = upsertAnnotationsNote(once, "paper.pdf", [], labels);
    expect(twice.startsWith(user.trimEnd())).toBe(true);
    expect(twice).toContain("More of my notes.");
    expect(readAnnotationsNote(twice)).toEqual([]);
  });

  it("a quoted marker pair before the real block is not taken for it", () => {
    const block = upsertAnnotationsNote(null, "paper.pdf", [ann()], labels);
    const md = `Example: ${NOTE_START} my words ${NOTE_END}\n\n${block}\nAfter.`;
    const pair = findManagedRegion(md)!;
    expect(md.slice(pair.start, pair.end)).toContain("lumen-pdf-annotations");
    expect(pair.start).toBeGreaterThan(md.indexOf("my words"));
    const next = upsertAnnotationsNote(md, "paper.pdf", [], labels);
    expect(next.startsWith(`Example: ${NOTE_START} my words ${NOTE_END}`)).toBe(true);
    expect(next.endsWith("\nAfter.")).toBe(true);
    expect(parseAnnotationsNote(next)).toEqual([]);
  });

  it("a stray start marker after the block doesn't capture the user's text", () => {
    const block = upsertAnnotationsNote(null, "paper.pdf", [ann()], labels);
    const md = `${block}\nLater I pasted ${NOTE_START} and kept writing.`;
    expect(readAnnotationsNote(md)).toHaveLength(1);
    const next = upsertAnnotationsNote(md, "paper.pdf", [], labels);
    expect(next).toContain(`Later I pasted ${NOTE_START} and kept writing.`);
  });

  it("a note that only quotes a start marker reads as having no highlights; a damaged block stays unreadable", () => {
    expect(readAnnotationsNote(`See ${NOTE_START} in the docs.`)).toEqual([]);
    expect(readAnnotationsNote(`${NOTE_START}\n\n\`\`\`json lumen-pdf-annotations\n[]\n\`\`\`\n`)).toBeNull();
  });
});

describe("2.23: the highlights list on narrow screens", () => {
  it("stacks under the pages instead of being hidden", () => {
    const css = readFileSync("src/pdf/PdfReader.css", "utf8");
    const at = css.indexOf("@media (max-width: 720px)");
    expect(at).toBeGreaterThan(-1);
    // The media block: up to its closing brace at the start of a line.
    const block = css.slice(at, css.indexOf("\n}", at));
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).toMatch(/\.pdf-body\s*\{[^}]*flex-direction:\s*column/);
    expect(block).toMatch(/\.pdf-side\s*\{[^}]*max-height/);
  });
});

describe("2.26: an annotation the reader can't show makes the block unreadable", () => {
  const note = (entries: unknown[]) => `${NOTE_START}\n\n\`\`\`\`json lumen-pdf-annotations\n${JSON.stringify(entries)}\n\`\`\`\`\n\n${NOTE_END}\n`;
  const good = ann() as unknown as Record<string, unknown>;

  it("accepts a well-formed annotation, with or without a note", () => {
    const withNote = createPdfAnnotation({ id: "a1", source: "paper.pdf", page: 1, text: "abc", start: 0, end: 3, note: "mine" });
    expect(readAnnotationsNote(note([good, withNote]))).toHaveLength(2);
  });

  it.each([
    ["body is an object", { ...good, body: {} }],
    ["body holds a non-TextualBody", { ...good, body: [{ type: "Other", value: "x" }] }],
    ["body value is not a string", { ...good, body: [{ type: "TextualBody", value: 3 }] }],
    ["created is missing", (({ created: _c, ...rest }) => rest)(good as unknown as PdfAnnotation)],
    ["created is a number", { ...good, created: 5 }],
    ["modified is not a string", { ...good, modified: {} }],
    ["a quote's exact is not a string", { ...good, target: { source: "paper.pdf", selector: [{ type: "FragmentSelector", value: "page=1", refinedBy: { type: "TextQuoteSelector", exact: 7 } }] } }],
    ["a position is not numeric", { ...good, target: { source: "paper.pdf", selector: [{ type: "FragmentSelector", value: "page=1", refinedBy: { type: "TextPositionSelector", start: "0", end: 4 } }] } }],
    ["an unknown refinement", { ...good, target: { source: "paper.pdf", selector: [{ type: "FragmentSelector", value: "page=1", refinedBy: { type: "CssSelector" } }] } }],
    ["the selector is null", { ...good, target: { source: "paper.pdf", selector: [null] } }],
  ])("rejects an entry where %s (strict read: null; lenient read drops it)", (_label: string, bad: unknown) => {
    const md = note([good, bad]);
    expect(readAnnotationsNote(md)).toBeNull();
    expect(parseAnnotationsNote(md)).toHaveLength(1);
  });
});
