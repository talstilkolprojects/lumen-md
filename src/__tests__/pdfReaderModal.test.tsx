/**
 * Review #272, coordinator decisions 2.18, 2.21, 2.25 and 2.26 (plan 4.14),
 * on the reader with pdf.js and the vault faked: a long PDF opens without
 * loading every page first, the reader is modal (the app underneath is
 * inert, focus comes back on close), Close waits for writes queued while it
 * waited, and a malformed annotation shows as an unreadable block instead of
 * crashing the reader.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

/** Pages per fake PDF, and the size of each page (page 2 of "mixed.pdf" is landscape). */
const FAKE = vi.hoisted(() => ({
  pages: { "long.pdf": 200, "mixed.pdf": 3 } as Record<string, number>,
  getPage: [] as number[],
}));

vi.mock("../storage/workspace", () => ({
  readWorkspaceBlob: vi.fn(async (path: string) => ({ arrayBuffer: async () => new TextEncoder().encode(path).buffer })),
  readWorkspaceFile: vi.fn(async () => {
    throw new DOMException("not found", "NotFoundError");
  }),
  writeWorkspaceFile: vi.fn(async () => undefined),
  workspaceHasEntry: vi.fn(async () => false),
}));

vi.mock("../pdf/pdfjs", () => {
  class TextLayer {
    private container: HTMLElement;
    constructor(o: { container: HTMLElement }) {
      this.container = o.container;
    }
    async render() {
      const span = document.createElement("span");
      span.textContent = "alpha two";
      this.container.appendChild(span);
    }
    cancel() {}
  }
  const page = (name: string, n: number) => {
    const [w, h] = name === "mixed.pdf" && n === 2 ? [800, 500] : [400, 600];
    return {
      getViewport: ({ scale }: { scale: number }) => ({ width: w * scale, height: h * scale, scale }),
      getTextContent: async () => ({ items: [{ str: "alpha two", hasEOL: false }] }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
      cleanup() {},
    };
  };
  return {
    loadPdfjs: async () => ({ TextLayer }),
    openPdf: async (data: Uint8Array) => {
      const name = new TextDecoder().decode(data);
      return {
        doc: {
          numPages: FAKE.pages[name],
          getPage: async (n: number) => {
            FAKE.getPage.push(n);
            return page(name, n);
          },
        },
        close: async () => undefined,
      };
    },
  };
});

import { PdfReader, drainQueue } from "../pdf/PdfReader";
import * as ws from "../storage/workspace";
import { createPdfAnnotation, upsertAnnotationsNote, NOTE_END, NOTE_START } from "../pdf/annotations";

afterEach(() => {
  cleanup();
  FAKE.getPage.length = 0;
  vi.mocked(ws.readWorkspaceFile).mockImplementation(async () => {
    throw new DOMException("not found", "NotFoundError");
  });
  vi.mocked(ws.writeWorkspaceFile).mockReset().mockImplementation(async () => undefined);
});

const reader = () => screen.getByTestId("pdf-reader");
const labels = { title: "Highlights", page: (n: number) => `p. ${n}`, empty: "none" };

describe("2.18: a long PDF opens with page 1's size", () => {
  it("doesn't load every page before showing the first", async () => {
    render(<PdfReader path="long.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} />);
    await waitFor(() => expect(reader().getAttribute("data-ready")).toBe("true"));
    expect(reader().getAttribute("data-page-count")).toBe("200");
    // Page 1 for the placeholder size, then only the pages near the view.
    expect(new Set(FAKE.getPage).size).toBeLessThan(10);
    const boxes = document.querySelectorAll<HTMLElement>("[data-page-number]");
    expect(boxes).toHaveLength(200);
    expect(boxes[150].style.height).toBe(boxes[0].style.height);
  });

  it("a page takes its real size once it is loaded", async () => {
    render(<PdfReader path="mixed.pdf" fragment="page=2" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} />);
    await waitFor(() => expect(reader().getAttribute("data-ready")).toBe("true"));
    const box = (n: number) => document.querySelector<HTMLElement>(`[data-page-number="${n}"]`)!;
    // Page 2 is landscape: wider than tall once it is rendered.
    await waitFor(() => expect(parseFloat(box(2).style.width)).toBeGreaterThan(parseFloat(box(2).style.height)));
    expect(parseFloat(box(1).style.width)).toBeLessThan(parseFloat(box(1).style.height));
    expect(reader().getAttribute("data-current-page")).toBe("2");
  });
});

describe("2.21: the reader is modal", () => {
  it("makes the app underneath inert while open and gives focus back on close", async () => {
    const editor = document.createElement("textarea");
    editor.setAttribute("data-testid", "editor");
    const toasts = document.createElement("div");
    toasts.setAttribute("data-modal-exempt", "");
    const host = document.createElement("div");
    const app = document.createElement("div");
    app.append(editor, toasts, host);
    document.body.appendChild(app);
    const alreadyInert = document.createElement("div");
    alreadyInert.setAttribute("inert", "");
    document.body.appendChild(alreadyInert);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const view = render(<PdfReader path="mixed.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} />, { container: host });
    await waitFor(() => expect(reader().getAttribute("data-ready")).toBe("true"));
    expect(editor.hasAttribute("inert")).toBe(true);
    expect(toasts.hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("inert")).toBe(false);
    expect(reader().contains(document.activeElement)).toBe(true);
    // Focus that still lands underneath (no `inert` support) comes back.
    editor.focus();
    expect(reader().contains(document.activeElement)).toBe(true);

    view.unmount();
    expect(editor.hasAttribute("inert")).toBe(false);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(editor);
    app.remove();
    alreadyInert.remove();
  });
});

describe("2.25: closing waits for every queued write", () => {
  it("drainQueue waits for a write queued while it was waiting", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const queue = { current: new Promise<void>((r) => (releaseFirst = r)).then(() => void order.push("first")) as Promise<unknown> };
    const drained = drainQueue(queue).then(() => order.push("drained"));
    let releaseSecond: () => void = () => undefined;
    queue.current = queue.current.then(() => new Promise<void>((r) => (releaseSecond = r))).then(() => void order.push("second"));
    releaseFirst();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["first"]);
    releaseSecond();
    await drained;
    expect(order).toEqual(["first", "second", "drained"]);
  });

  it("a highlight deleted while Close waits is saved before the reader closes", async () => {
    const a1 = createPdfAnnotation({ id: "11111111-e89b-42d3-a456-426614174000", source: "mixed.pdf", page: 1, text: "alpha two", start: 0, end: 5 });
    const a2 = createPdfAnnotation({ id: "22222222-e89b-42d3-a456-426614174000", source: "mixed.pdf", page: 1, text: "alpha two", start: 6, end: 9 });
    const note = upsertAnnotationsNote(null, "mixed.pdf", [a1, a2], labels);
    vi.mocked(ws.readWorkspaceFile).mockImplementation(async () => note);
    const write = vi.mocked(ws.writeWorkspaceFile);
    const finish: (() => void)[] = [];
    write.mockImplementation(() => new Promise<void>((r) => finish.push(() => r())));
    const onClose = vi.fn();
    render(<PdfReader path="mixed.pdf" openSeq={1} onClose={onClose} onOpenNotes={() => undefined} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("pdf-close"));
    // While Close waits on the first write, the other highlight is deleted too.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    finish[0]();
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
    finish[1]();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(String(write.mock.calls[1][1])).not.toContain("22222222");
  });
});

describe("2.26: a malformed annotation", () => {
  it("shows the block as unreadable instead of crashing, and nothing is saved over it", async () => {
    const good = createPdfAnnotation({ id: "33333333-e89b-42d3-a456-426614174000", source: "mixed.pdf", page: 1, text: "alpha", start: 0, end: 5 });
    const md = `${NOTE_START}\n\n\`\`\`json lumen-pdf-annotations\n${JSON.stringify([{ ...good, body: {} }])}\n\`\`\`\n\n${NOTE_END}\n`;
    vi.mocked(ws.readWorkspaceFile).mockImplementation(async () => md);
    render(<PdfReader path="mixed.pdf" openSeq={1} onClose={() => undefined} onOpenNotes={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toContain("mixed.pdf.md");
    expect(reader().getAttribute("data-ready")).toBeNull();
    expect(ws.writeWorkspaceFile).not.toHaveBeenCalled();
  });
});
