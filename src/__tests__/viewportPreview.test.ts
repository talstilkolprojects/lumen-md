/**
 * Plan 8.1 step 3 (W10.E3) — a long note renders viewport first.
 *
 * The block-by-block preview (src/renderer/incrementalPreview.ts) renders
 * the blocks the reader sees first and shows them (`onPartial`) before the
 * rest of the note is done; pending blocks are placeholders about as tall
 * as their text. Blocks go through the render worker's handler
 * (src/renderer/renderWorkerCore.ts) behind a structured-clone port; the
 * final preview is the same as the full pipeline's. The TBT number
 * (< 300 ms) needs a real browser: owed on the Mac.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { IncrementalPreview } from "../renderer/incrementalPreview";
import { renderMarkdown, renderStats } from "../renderer/pipeline";
import { setRenderPortFactory, type RenderPort } from "../renderer/renderClient";
import { createRenderHandler } from "../renderer/renderWorkerCore";
import type { RenderReply } from "../renderer/renderProtocol";
import { blockAt, estimateBlockHeight, firstScreen, RenderQueue } from "../renderer/viewport";
import { handleWikiLinkClick } from "../renderer/wikiLinks";

const html = (el: ReactElement | null) => renderToStaticMarkup(el!).replace(/>\s+</g, "><").trim();

function inProcessWorker(): RenderPort {
  const handler = createRenderHandler();
  const port: RenderPort = {
    onmessage: null,
    onerror: null,
    terminate() {},
    postMessage(msg) {
      void handler.handle(structuredClone(msg)).then((reply) => {
        if (reply) setTimeout(() => port.onmessage?.({ data: structuredClone(reply) } as MessageEvent<RenderReply>), 0);
      });
    },
  };
  return port;
}

/** A synthetic note (labelled as such): sections of headings, prose, lists, a table, code; repeated headings. */
function syntheticNote(targetBytes: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < targetBytes; i++) {
    const s = [
      `## Section ${i % 50}`,
      `Paragraph ${i} with **bold**, _emphasis_, a [[Wiki ${i}]] link and עברית באמצע the line. `.repeat(6),
      `- item ${i}.a\n- item ${i}.b\n- [ ] task ${i}`,
      i % 7 === 0 ? "| a | b |\n|---|---|\n| 1 | 2 |" : `> quote ${i}`,
      i % 11 === 0 ? "```ts\nconst x = " + i + ";\n```" : `Closing line ${i}.`,
    ].join("\n\n");
    parts.push(s);
    size += s.length + 2;
  }
  return "# A long note\n\n" + parts.join("\n\n") + "\n";
}

afterEach(() => setRenderPortFactory());

describe("viewport helpers", () => {
  it("estimates a placeholder from the text, finds the block at an offset, takes a screen from there", () => {
    expect(estimateBlockHeight("one line")).toBe(40);
    expect(estimateBlockHeight("x".repeat(160) + "\n\n" + "y")).toBe(3 * 24 + 16);
    const blocks = [
      { start: 0, end: 10 },
      { start: 10, end: 30 },
      { start: 30, end: 31 },
    ];
    expect([0, 9, 10, 29, 30, 999].map((o) => blockAt(blocks, o))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(firstScreen([100, 100, 100, 100], 1, 150)).toEqual([1, 2]);
    expect(firstScreen([500], 0, 100)).toEqual([0]);
    expect(firstScreen([10, 10], 5, 100)).toEqual([]);
  });

  it("the queue: first screen, then document order; a block scrolled to jumps the queue", () => {
    const q = new RenderQueue([0, 1, 2, 3, 4, 5], [3, 4]);
    expect(q.next()).toBe(3);
    expect(q.next()).toBe(4);
    expect(q.next([5])).toBe(5);
    expect(q.next([5])).toBe(0); // already taken: back to the order
    expect([q.next(), q.next(), q.next()]).toEqual([1, 2, undefined]);
  });
});

describe("a long note renders the first screen first", () => {
  it("a 2 MB note: the first block is shown before the note is done, and the end result is the full pipeline's", async () => {
    const doc = syntheticNote(2 * 1024 * 1024);
    expect(doc.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    setRenderPortFactory(() => inProcessWorker());
    const preview = new IncrementalPreview();
    const partials: { html: string | null; pending: number; rendered: number }[] = [];
    const main = renderStats.mainThread;
    const done = await preview.render(doc, () => false, () => false, {
      viewportPx: 1200,
      // Only the first partial's markup is kept (each one is up to 2 MB).
      onPartial: (el) => partials.push({ html: partials.length ? null : html(el), pending: preview.pending, rendered: preview.rendered }),
    });
    expect(partials.length).toBeGreaterThan(0);
    const first = partials[0];
    // The first screen is there, most of the note is not.
    expect(first.html).toContain("A long note</h1>");
    expect(first.html).toContain("data-lumen-pending");
    expect(first.pending).toBeGreaterThan(100);
    expect(first.rendered).toBeLessThan(preview.rendered / 10);
    // All of it rendered in the worker; the finished preview has no placeholders.
    expect(preview.renderedInWorker).toBe(preview.rendered);
    expect(renderStats.mainThread).toBe(main);
    const final = html(done);
    expect(final).not.toContain("data-lumen-pending");
    // Repeated headings numbered across the whole note, as rehype-slug numbers them.
    expect(final).toContain('id="section-0-1"');
  }, 900_000);

  it("a 300 KB note: the viewport-first result is exactly the full pipeline's", async () => {
    const doc = syntheticNote(300_000);
    setRenderPortFactory(() => inProcessWorker());
    const preview = new IncrementalPreview();
    let partials = 0;
    const done = html(await preview.render(doc, () => false, () => false, { focusOffset: doc.length >> 1, onPartial: () => partials++ }));
    expect(partials).toBeGreaterThan(0);
    setRenderPortFactory(() => null);
    expect(done).toBe(html(await renderMarkdown(doc, () => false)));
  }, 600_000);

  it("the focus decides the first screen: a block in the middle comes before the top", async () => {
    const doc = syntheticNote(200_000);
    setRenderPortFactory(() => inProcessWorker());
    const preview = new IncrementalPreview();
    const focus = doc.indexOf("Paragraph 150 ");
    expect(focus).toBeGreaterThan(0);
    let first: string | null = null;
    await preview.render(doc, () => false, () => false, {
      focusOffset: focus,
      viewportPx: 400,
      onPartial: (el) => {
        first ??= html(el);
      },
    });
    expect(first).toContain("Paragraph 150 ");
    expect(first).not.toContain("A long note</h1>");
    expect(first!.startsWith('<div data-lumen-pending="0"')).toBe(true);
  }, 300_000);

  it("an edit renders only the changed block, and a kept block whose heading ids moved is re-numbered, not re-rendered", async () => {
    setRenderPortFactory(() => inProcessWorker());
    const doc = ["# T", "## Repeat", "text", "## Repeat", "end"].join("\n\n");
    const preview = new IncrementalPreview();
    expect(html(await preview.render(doc, () => false))).toContain('id="repeat-1"');
    const before = preview.rendered;
    // A new "Repeat" above both: the kept ones become -1 and -2.
    const edited = doc.replace("# T", "# T\n\n## Repeat");
    const out = html(await preview.render(edited, () => false));
    expect(preview.rendered - before).toBe(1);
    expect(out).toContain('id="repeat-2"');
    setRenderPortFactory(() => null);
    expect(out).toBe(html(await renderMarkdown(edited, () => false)));
  }, 120_000);
});

describe("links to a heading of a block still rendering", () => {
  it("[[#Heading]] in a preview that is still rendering waits for the heading instead of doing nothing", () => {
    document.body.innerHTML = '<div data-preview-root data-preview-pending data-preview-doc="d"><a class="wiki-link" data-wiki-target="#Later" href="#later">x</a></div>';
    const root = document.querySelector<HTMLElement>("[data-preview-root]")!;
    const a = root.querySelector("a")!;
    let prevented = false;
    const handled = handleWikiLinkClick({ target: a, preventDefault: () => (prevented = true) }, root, async () => [], () => {});
    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    root.removeAttribute("data-preview-pending");
    prevented = false;
    expect(handleWikiLinkClick({ target: a, preventDefault: () => (prevented = true) }, root, async () => [], () => {})).toBe(false);
    expect(prevented).toBe(false);
    document.body.innerHTML = "";
  });
});
