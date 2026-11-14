/**
 * Plan 4.14 — a PDF and its highlights note (`<file>.pdf.md`) move together;
 * a declined replace leaves both where they were; a PDF renamed by its stem
 * stays a PDF.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeDir, installFakeOpfs } from "./helpers/fakeOpfs";
import { readWorkspaceBlob, readWorkspaceFile, workspaceHasEntry, writeWorkspaceBlob, writeWorkspaceFile } from "../storage/workspace";
import { companionNoteOf, duplicateFile, renamedFileName, safeMoveWithCompanion, withoutCompanions } from "../storage/fileOps";
import { rewriteLinks } from "../storage/linkRewrite";
import { listTrash } from "../storage/trash";

beforeEach(() => {
  installFakeOpfs();
});

describe("renamedFileName", () => {
  it("keeps a non-Markdown file's extension when a bare name is typed", () => {
    expect(renamedFileName("papers/paper.pdf", "draft")).toBe("draft.pdf");
    expect(renamedFileName("data.csv", "table")).toBe("table.csv");
  });

  it("gives notes .md, and keeps any extension that was typed", () => {
    expect(renamedFileName("a.md", "b")).toBe("b.md");
    expect(renamedFileName("a.markdown", "b")).toBe("b.md");
    expect(renamedFileName("README", "b")).toBe("b.md");
    expect(renamedFileName("paper.pdf", "notes.md")).toBe("notes.md");
    expect(renamedFileName("paper.pdf", "draft.v2.pdf")).toBe("draft.v2.pdf");
  });

  it("only PDFs have a companion note", () => {
    expect(companionNoteOf("a/paper.PDF")).toBe("a/paper.PDF.md");
    expect(companionNoteOf("a/paper.md")).toBeNull();
  });
});

describe("safeMoveWithCompanion", () => {
  it("moves the PDF and its highlights note together", async () => {
    await writeWorkspaceFile("paper.pdf", "%PDF");
    await writeWorkspaceFile("paper.pdf.md", "highlights");
    const m = await safeMoveWithCompanion("paper.pdf", "archive/draft.pdf");
    expect(m?.main.path).toBe("archive/draft.pdf");
    expect(m?.companion?.path).toBe("archive/draft.pdf.md");
    expect(await readWorkspaceFile("archive/draft.pdf.md")).toBe("highlights");
    expect(await workspaceHasEntry("paper.pdf")).toBe(false);
    expect(await workspaceHasEntry("paper.pdf.md")).toBe(false);
  });

  it("asks about both destinations first; a declined replace moves nothing and deletes nothing", async () => {
    await writeWorkspaceFile("paper.pdf", "%PDF");
    await writeWorkspaceFile("paper.pdf.md", "mine");
    await writeWorkspaceFile("draft.pdf.md", "theirs");
    const confirmReplace = vi.fn(async () => false);
    expect(await safeMoveWithCompanion("paper.pdf", "draft.pdf", { confirmReplace })).toBeNull();
    expect(confirmReplace).toHaveBeenCalledWith("draft.pdf.md");
    expect(await readWorkspaceFile("paper.pdf")).toBe("%PDF");
    expect(await readWorkspaceFile("paper.pdf.md")).toBe("mine");
    expect(await readWorkspaceFile("draft.pdf.md")).toBe("theirs");
    expect(await workspaceHasEntry("draft.pdf")).toBe(false);
    expect(await listTrash()).toEqual([]);
  });

  it("asks once per destination when the user agrees, and the replaced files go to the trash", async () => {
    await writeWorkspaceFile("paper.pdf", "%PDF new");
    await writeWorkspaceFile("paper.pdf.md", "new notes");
    await writeWorkspaceFile("draft.pdf", "%PDF old");
    await writeWorkspaceFile("draft.pdf.md", "old notes");
    const confirmReplace = vi.fn(async () => true);
    const m = await safeMoveWithCompanion("paper.pdf", "draft.pdf", { confirmReplace });
    expect(m?.companion?.path).toBe("draft.pdf.md");
    expect(confirmReplace.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["draft.pdf", "draft.pdf.md"]);
    expect(await readWorkspaceFile("draft.pdf")).toBe("%PDF new");
    expect(await readWorkspaceFile("draft.pdf.md")).toBe("new notes");
    expect((await listTrash()).length).toBe(2);
  });

  it("leaves the note alone when it is part of the same move, and moves a PDF without one", async () => {
    await writeWorkspaceFile("paper.pdf", "%PDF");
    await writeWorkspaceFile("paper.pdf.md", "notes");
    const m = await safeMoveWithCompanion("paper.pdf", "dir/paper.pdf", { alsoMoving: new Set(["paper.pdf", "paper.pdf.md"]) });
    expect(m?.companion).toBeNull();
    expect(await readWorkspaceFile("paper.pdf.md")).toBe("notes");
    await writeWorkspaceFile("lone.pdf", "%PDF");
    expect((await safeMoveWithCompanion("lone.pdf", "x.pdf"))?.main.path).toBe("x.pdf");
  });
});

describe("a multi-file move with a PDF and its note both selected", () => {
  it("moves them as one unit: the note is left to the PDF's move", () => {
    expect(withoutCompanions(["b.md", "paper.pdf.md", "paper.pdf", "x/other.pdf.md"])).toEqual(["b.md", "paper.pdf", "x/other.pdf.md"]);
  });

  it("so a declined replace of the note's destination keeps the pair together", async () => {
    await writeWorkspaceFile("paper.pdf", "%PDF");
    await writeWorkspaceFile("paper.pdf.md", "mine");
    await writeWorkspaceFile("dir/paper.pdf.md", "theirs");
    const confirmReplace = vi.fn(async () => false);
    for (const p of withoutCompanions(["paper.pdf.md", "paper.pdf"])) {
      expect(await safeMoveWithCompanion(p, `dir/${p}`, { confirmReplace })).toBeNull();
    }
    expect(await readWorkspaceFile("paper.pdf")).toBe("%PDF");
    expect(await readWorkspaceFile("paper.pdf.md")).toBe("mine");
    expect(await readWorkspaceFile("dir/paper.pdf.md")).toBe("theirs");
    expect(await workspaceHasEntry("dir/paper.pdf")).toBe(false);
  });
});

describe("duplicating a binary file", () => {
  it("copies the bytes exactly (a PDF isn't read and rewritten as text)", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
    await writeWorkspaceBlob("docs/paper.pdf", bytes);
    const copy = await duplicateFile("docs/paper.pdf");
    expect(copy).toBe("docs/paper copy.pdf");
    expect(Array.from(new Uint8Array(await (await readWorkspaceBlob(copy)).arrayBuffer()))).toEqual(Array.from(bytes));
    expect(await duplicateFile("docs/paper.pdf")).toBe("docs/paper copy 2.pdf");
  });
});

describe("links when a PDF and its note move", () => {
  it("are rewritten in percent-encoded form for paths with wiki syntax", () => {
    const md = "- [[draft%232.pdf#page=1&highlight=abcd1234|p. 1]] and [[a/draft%232.pdf#page=2&highlight=ef|p. 2]]";
    expect(rewriteLinks(md, "x.md", "draft#2.pdf", "final [v|3].pdf")).toBe(
      "- [[final %5Bv%7C3%5D.pdf#page=1&highlight=abcd1234|p. 1]] and [[a/draft%232.pdf#page=2&highlight=ef|p. 2]]",
    );
    expect(rewriteLinks("[[a/draft%232.pdf#page=2|p. 2]]", "x.md", "a/draft#2.pdf", "b/draft#2.pdf")).toBe("[[b/draft%232.pdf#page=2|p. 2]]");
    // Hand-written links without escapes stay as they were written.
    expect(rewriteLinks("[[paper.pdf]]", "x.md", "paper.pdf", "draft.pdf")).toBe("[[draft.pdf]]");
  });

  it("follow a PDF whose name needs escaping, in its moved note too", async () => {
    await writeWorkspaceFile("draft#2.pdf", "%PDF");
    await writeWorkspaceFile("draft#2.pdf.md", "- [[draft%232.pdf#page=1&highlight=abcd1234|p. 1]]");
    const m = await safeMoveWithCompanion("draft#2.pdf", "final.pdf");
    expect(m?.companion?.path).toBe("final.pdf.md");
    expect(await readWorkspaceFile("final.pdf.md")).toBe("- [[final.pdf#page=1&highlight=abcd1234|p. 1]]");
  });

  it("are left alone when the note's move fails after the PDF moved", async () => {
    await writeWorkspaceFile("A.pdf", "%PDF A");
    await writeWorkspaceFile("A.pdf.md", "notes on A");
    await writeWorkspaceFile("B.pdf", "%PDF B");
    await writeWorkspaceFile("other.md", "[[A.pdf]] and [[B.pdf]]");
    const real = FakeDir.prototype.getFileHandle;
    const spy = vi.spyOn(FakeDir.prototype, "getFileHandle").mockImplementation(function (this: FakeDir, name, opts) {
      if (name === "B.pdf.md" && opts?.create) return Promise.reject(new DOMException("full", "QuotaExceededError"));
      return real.call(this, name, opts);
    });
    await expect(safeMoveWithCompanion("A.pdf", "B.pdf", { confirmReplace: async () => true })).rejects.toThrow("full");
    spy.mockRestore();
    expect(await readWorkspaceFile("A.pdf")).toBe("%PDF A");
    expect(await readWorkspaceFile("A.pdf.md")).toBe("notes on A");
    expect(await readWorkspaceFile("B.pdf")).toBe("%PDF B");
    expect(await readWorkspaceFile("other.md")).toBe("[[A.pdf]] and [[B.pdf]]");
  });
});
