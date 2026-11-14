/**
 * Plan 4.14 — the PDF reader component, with pdf.js and the vault faked:
 * opening a second PDF in the same reader starts from a clean slate (page,
 * search, OCR), and Previous as the first search step goes to the last match.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

/** Page texts per PDF ("" = a scanned page). Hoisted: the mocks below use it. */
const DOCS = vi.hoisted((): Record<string, string[]> => ({
  "a.pdf": ["", "alpha two", "alpha three"],
  "b.pdf": ["bravo one", "bravo two"],
}));

vi.mock("../storage/workspace", () => ({
  // The "bytes" of a fake PDF: one byte naming it (see openPdf below).
  readWorkspaceBlob: vi.fn(async (path: string) => ({ arrayBuffer: async () => new Uint8Array([path === "a.pdf" ? 1 : 2]).buffer })),
  readWorkspaceFile: vi.fn(async () => {
    throw new DOMException("a.pdf.md not found", "NotFoundError");
  }),
  writeWorkspaceFile: vi.fn(async () => undefined),
  workspaceHasEntry: vi.fn(async () => false),
}));

vi.mock("../ai/ocr", () => ({
  ocrImage: vi.fn(async () => ({ text: "recognised words", confidence: 90 })),
}));

vi.mock("../pdf/pdfjs", () => {
  class TextLayer {
    private texts: string[];
    private container: HTMLElement;
    constructor(o: { textContentSource: { items: { str?: string }[] }; container: HTMLElement }) {
      this.texts = o.textContentSource.items.map((i) => i.str ?? "");
      this.container = o.container;
    }
    async render() {
      for (const s of this.texts) {
        if (!s) continue;
        const span = document.createElement("span");
        span.textContent = s;
        this.container.appendChild(span);
      }
    }
    cancel() {}
  }
  const page = (text: string) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale, scale }),
    getTextContent: async () => ({ items: [{ str: text, hasEOL: false }] }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    cleanup() {},
  });
  return {
    loadPdfjs: async () => ({ TextLayer }),
    openPdf: async (data: Uint8Array) => {
      const texts = DOCS[data[0] === 1 ? "a.pdf" : "b.pdf"];
      return { doc: { numPages: texts.length, getPage: async (n: number) => page(texts[n - 1]) }, close: async () => undefined };
    },
  };
});

import { PdfReader } from "../pdf/PdfReader";
import * as ws from "../storage/workspace";
import { createPdfAnnotation, upsertAnnotationsNote } from "../pdf/annotations";

afterEach(() => cleanup());

const reader = () => screen.getByTestId("pdf-reader");
const props = { onClose: () => undefined, onOpenNotes: () => undefined };

describe("PdfReader", () => {
  it("opening a second PDF resets the page, the search and the OCR text", async () => {
    const view = render(<PdfReader path="a.pdf" fragment="page=3" openSeq={1} {...props} />);
    await waitFor(() => expect(reader().getAttribute("data-page-count")).toBe("3"));
    await waitFor(() => expect(reader().getAttribute("data-current-page")).toBe("3"));

    // Page 1 is scanned: recognise it.
    fireEvent.click(await screen.findByRole("button", { name: "Recognise text (OCR)" }));
    await waitFor(() => expect(document.querySelector('[data-pdf-text="ocr"]')?.textContent).toBe("recognised words"));

    const search = screen.getByTestId("pdf-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "alpha" } });
    fireEvent.submit(search.closest("form")!);
    await waitFor(() => expect(screen.getByTestId("pdf-search-count").textContent).toMatch(/of 2/));

    view.rerender(<PdfReader path="b.pdf" fragment={null} openSeq={2} {...props} />);
    await waitFor(() => expect(reader().getAttribute("data-page-count")).toBe("2"));
    expect(reader().getAttribute("data-current-page")).toBe("1");
    expect((screen.getByTestId("pdf-search") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("pdf-search-count").textContent).toBe("");
    expect(document.querySelector('[data-pdf-text="ocr"]')).toBeNull();
  });

  it("goes to the last match when Previous is the first search step", async () => {
    render(<PdfReader path="a.pdf" openSeq={1} {...props} />);
    await waitFor(() => expect(reader().getAttribute("data-page-count")).toBe("3"));
    fireEvent.change(screen.getByTestId("pdf-search"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    await waitFor(() => expect(screen.getByTestId("pdf-search-count").textContent).toBe("2 of 2"));
    await waitFor(() => expect(reader().getAttribute("data-current-page")).toBe("3"));
  });

  it("stays open when the highlights couldn't be saved, and closes once a retry saves them", async () => {
    const ann = createPdfAnnotation({ id: "123e4567-e89b-42d3-a456-426614174000", source: "a.pdf", page: 2, text: "alpha two", start: 0, end: 5 });
    const note = upsertAnnotationsNote(null, "a.pdf", [ann], { title: "Highlights — a.pdf", page: (n) => `p. ${n}`, empty: "none" });
    const read = vi.mocked(ws.readWorkspaceFile);
    const write = vi.mocked(ws.writeWorkspaceFile);
    read.mockImplementation(async () => note);
    write.mockClear();
    write.mockRejectedValueOnce(new Error("quota"));
    const onClose = vi.fn();
    render(<PdfReader path="a.pdf" openSeq={1} onClose={onClose} onOpenNotes={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    // The delete's write fails…
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    write.mockRejectedValueOnce(new Error("quota"));
    fireEvent.click(screen.getByTestId("pdf-close"));
    // …and so does the retry on Close: the reader stays, nothing is dropped.
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("pdf-reader")).toBeTruthy();
    // The next Close retries again, the write succeeds, the reader closes.
    fireEvent.click(screen.getByTestId("pdf-close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(3);
    expect(String(write.mock.calls[2][1])).not.toContain("alpha");
    read.mockImplementation(async () => {
      throw new DOMException("a.pdf.md not found", "NotFoundError");
    });
  });

  it("Open the notes creates the highlights note first when the PDF has none", async () => {
    const write = vi.mocked(ws.writeWorkspaceFile);
    write.mockClear();
    const onOpenNotes = vi.fn();
    render(<PdfReader path="a.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={onOpenNotes} />);
    await waitFor(() => expect(reader().getAttribute("data-page-count")).toBe("3"));
    fireEvent.click(screen.getByTestId("pdf-open-notes"));
    await waitFor(() => expect(onOpenNotes).toHaveBeenCalledWith("a.pdf.md"));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("a.pdf.md");
    expect(String(write.mock.calls[0][1])).toContain("<!-- lumen:pdf-annotations:start -->");
  });

  it("doesn't open for editing when the highlights note exists but can't be read", async () => {
    const read = vi.mocked(ws.readWorkspaceFile);
    const write = vi.mocked(ws.writeWorkspaceFile);
    write.mockClear();
    read.mockImplementation(async () => {
      throw new DOMException("busy", "NoModificationAllowedError");
    });
    render(<PdfReader path="a.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("busy");
    expect(reader().getAttribute("data-ready")).toBeNull();
    expect(screen.getByTestId("pdf-highlight").hasAttribute("disabled")).toBe(true);
    expect(write).not.toHaveBeenCalled();
    read.mockImplementation(async () => {
      throw new DOMException("a.pdf.md not found", "NotFoundError");
    });
  });

  it("asks before the page unloads while highlights aren't saved yet", async () => {
    const ann = createPdfAnnotation({ id: "123e4567-e89b-42d3-a456-426614174000", source: "a.pdf", page: 2, text: "alpha two", start: 0, end: 5 });
    const note = upsertAnnotationsNote(null, "a.pdf", [ann], { title: "Highlights — a.pdf", page: (n) => `p. ${n}`, empty: "none" });
    const read = vi.mocked(ws.readWorkspaceFile);
    const write = vi.mocked(ws.writeWorkspaceFile);
    read.mockImplementation(async () => note);
    let finish: () => void = () => undefined;
    write.mockClear();
    write.mockImplementationOnce(() => new Promise<void>((r) => (finish = () => r())));
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    render(<PdfReader path="a.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    // The write is still running: leaving now would lose the change.
    expect(unload()).toBe(true);
    finish();
    await waitFor(() => expect(unload()).toBe(false));
    read.mockImplementation(async () => {
      throw new DOMException("a.pdf.md not found", "NotFoundError");
    });
  });

  it("hands its save gate to the app: opening another PDF waits for the highlights to be saved", async () => {
    const ann = createPdfAnnotation({ id: "123e4567-e89b-42d3-a456-426614174000", source: "a.pdf", page: 2, text: "alpha two", start: 0, end: 5 });
    const note = upsertAnnotationsNote(null, "a.pdf", [ann], { title: "Highlights — a.pdf", page: (n) => `p. ${n}`, empty: "none" });
    const read = vi.mocked(ws.readWorkspaceFile);
    const write = vi.mocked(ws.writeWorkspaceFile);
    read.mockImplementation(async () => note);
    let finish: () => void = () => undefined;
    write.mockClear();
    write.mockImplementationOnce(() => new Promise<void>((r) => (finish = () => r())));
    const held: { gate: ((then: () => void) => void) | null } = { gate: null };
    const view = render(
      <PdfReader path="a.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} registerSaveGate={(g) => (held.gate = g)} />,
    );
    await waitFor(() => expect(held.gate).not.toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const replace = vi.fn();
    held.gate!(replace);
    await new Promise((r) => setTimeout(r, 0));
    expect(replace).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(held.gate).toBeNull();
    read.mockImplementation(async () => {
      throw new DOMException("a.pdf.md not found", "NotFoundError");
    });
  });

  it("doesn't open for editing when the highlights block is broken", async () => {
    const read = vi.mocked(ws.readWorkspaceFile);
    const write = vi.mocked(ws.writeWorkspaceFile);
    write.mockClear();
    read.mockImplementation(async () => "<!-- lumen:pdf-annotations:start -->\n\n```json lumen-pdf-annotations\n[{\"type\": \"Annota\n```\n\n<!-- lumen:pdf-annotations:end -->\n");
    render(<PdfReader path="a.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toContain("a.pdf.md");
    expect(reader().getAttribute("data-ready")).toBeNull();
    expect(write).not.toHaveBeenCalled();
    read.mockImplementation(async () => {
      throw new DOMException("a.pdf.md not found", "NotFoundError");
    });
  });
});
