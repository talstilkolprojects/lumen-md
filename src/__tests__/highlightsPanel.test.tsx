/**
 * Plan W1.15 — the "All highlights" panel, rendered over a real vault: it
 * lists the PDF / EPUB / clip highlights, searches them, saves a new tag in
 * the sidecar note, exports the results to a note with a link per
 * highlight, and drags a highlight as a quote with its link.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { HighlightsPanel } from "../highlights/HighlightsPanel";
import { createPdfAnnotation, readAnnotationsNote, upsertAnnotationsNote } from "../pdf/annotations";
import { createEpubAnnotation, upsertEpubNote } from "../epub/annotations";
import { tagsOf } from "../highlights/hub";
import { listWorkspace, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function until<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const NOW = new Date("2026-11-10T08:00:00Z");
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

async function seedVault() {
  const text = "Results show that the method works. השיטה עובדת היטב.";
  const pdf = Array.from({ length: 20 }, (_, i) => createPdfAnnotation({ id: uuid(100 + i), source: "hl/paper.pdf", page: i + 1, text, start: 0, end: 34, now: NOW }));
  await writeWorkspaceFile("hl/paper.pdf.md", upsertAnnotationsNote(null, "hl/paper.pdf", pdf, { title: "Highlights — paper.pdf", page: (n) => `p. ${n}`, empty: "_none_" }));
  const epub = [createEpubAnnotation({ id: uuid(1), source: "hl/book.epub", chapter: 2, text: "Call me Ishmael. Some years ago.", start: 0, end: 15, now: NOW })];
  await writeWorkspaceFile("hl/book.epub.md", upsertEpubNote(null, "hl/book.epub", epub, { title: "Highlights — Book", chapter: (n, l) => (l ? `ch. ${n}: ${l}` : `ch. ${n}`), empty: "_none_" }, () => "Loomings"));
  await writeWorkspaceFile("hl/clip.md", `---\nsource: "https://example.com/a"\nclipped: "2026-11-10"\n---\n\nIt was ==a bright cold day== in April.\n`);
}

describe("All highlights panel (W1.15)", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(async () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await seedVault();
  });

  it("lists, searches, tags into the sidecar, exports with links, drags as a quote", async () => {
    await act(async () => root.render(createElement(HighlightsPanel, { onClose: () => undefined })));
    const count = () => host.querySelector('[data-testid="highlights-count"]')?.textContent ?? "";
    await until(() => /^22 of 22/.test(count()));

    const input = host.querySelector<HTMLInputElement>('[data-testid="highlights-search"]')!;
    const type = async (v: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("ishmael");
    await until(() => /^1 of 22/.test(count()));
    expect(host.querySelector('[data-testid="highlight-item"] .hl-quote')?.textContent).toBe("“Call me Ishmael”");

    // Tag it: the sidecar note gets a tagging body.
    const tagInput = host.querySelector<HTMLInputElement>('[data-testid="highlight-item"] .hl-addtag')!;
    await act(async () => {
      tagInput.value = "classics";
      tagInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await until(() => host.querySelector(".hl-tag")?.textContent?.startsWith("#classics"));
    const md = await readWorkspaceFile("hl/book.epub.md");
    const { readEpubNote } = await import("../epub/annotations");
    expect(tagsOf(readEpubNote(md)![0])).toEqual(["classics"]);
    expect(md).toContain("|ch. 2: Loomings]]");

    // Drag: a quote with the link to the highlight.
    const dt = new DataTransfer();
    host.querySelector('[data-testid="highlight-item"]')!.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    expect(dt.getData("text/plain")).toBe("> Call me Ishmael\n> — [[hl/book.epub#chapter=2&highlight=00000001|ch. 2]] #classics");

    // The 20 PDF highlights → export: one link per highlight, each to its own page.
    await type("method");
    await until(() => /^20 of 22/.test(count()));
    const before = new Set((await listWorkspace()).map((f) => f.path));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="highlights-export"]')!.click());
    const exported = await until(async () => (await listWorkspace()).map((f) => f.path).find((p) => !before.has(p) && p.endsWith(".md")));
    const note = await readWorkspaceFile(exported);
    const ids = readAnnotationsNote(await readWorkspaceFile("hl/paper.pdf.md"))!.map((a) => a.id.replace(/^urn:uuid:/, "").replace(/-/g, "").slice(0, 8));
    for (const [i, id] of ids.entries()) expect(note).toContain(`[[hl/paper.pdf#page=${i + 1}&highlight=${id}|p. ${i + 1}]]`);
    expect(note.match(/\[\[hl\/paper\.pdf#page=/g)).toHaveLength(20);
    await act(async () => root.unmount());
  });
});
