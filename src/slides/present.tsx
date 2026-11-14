/**
 * Starting a presentation (plan W2.17), from a note or from the canvas.
 * Every slide is rendered up front: notes with the app's own Markdown
 * renderer, canvas frames as SVG (Excalidraw's export of the frame, with
 * W1.16's Hebrew fixes and note cards drawn).
 */

import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { noteToDeck, framesToDeck, type CanvasElementLike, type Dir } from "./deck";
import { Presentation, type SlideView } from "./Presentation";

let mounted: { root: Root; host: HTMLElement; urls: string[] } | null = null;

function show(title: string, dir: Dir, slides: SlideView[], start = 0, urls: string[] = []): void {
  stop();
  const host = document.createElement("div");
  host.setAttribute("data-lumen-slides-host", "");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host, urls };
  root.render(createElement(Presentation, { title, dir, slides, start, onClose: stop }));
}

export function stop(): void {
  if (!mounted) return;
  mounted.root.unmount();
  mounted.host.remove();
  for (const u of mounted.urls) URL.revokeObjectURL(u);
  mounted = null;
}

const isDark = () => false;

/** Present a note. `start`: the slide under the cursor, when known. */
export async function presentNote(md: string, name: string, start = 0): Promise<number> {
  const deck = noteToDeck(md, name.replace(/\.[^.]+$/, ""));
  const { renderMarkdown } = await import("../renderer/pipeline");
  const contents: ReactNode[] = await Promise.all(deck.slides.map((s) => renderMarkdown(s.markdown, isDark)));
  show(
    deck.title,
    deck.dir,
    deck.slides.map((s, i) => ({ title: s.title, notes: s.notes, dir: s.dir, content: contents[i] })),
    Math.min(start, deck.slides.length - 1),
  );
  return deck.slides.length;
}

/** The editor's cursor line (0-based), or 0 when no editor is open (e.g. in preview). */
export async function cursorLine(): Promise<number> {
  const el = document.querySelector<HTMLElement>(".cm-editor");
  if (!el) return 0;
  try {
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(el);
    return view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0;
  } catch {
    return 0;
  }
}

/** The slide that holds a given line of the note (0-based), for "present from here". */
export function slideAtLine(md: string, line: number): number {
  const before = md.split("\n").slice(0, line + 1).join("\n");
  return Math.max(0, noteToDeck(before).slides.length - 1);
}

/** Present the canvas: one slide per frame, in arrow order. → the number of slides (0: no frames). */
export async function presentCanvas(
  scene: { elements: readonly CanvasElementLike[]; appState: Record<string, unknown>; files: Record<string, unknown> },
  title: string,
  read: (path: string) => Promise<string | null>,
): Promise<number> {
  const frames = framesToDeck(scene.elements);
  if (!frames.length) return 0;
  const [{ exportToSvg }, { cardContents }, { cardsForExport }, { fixHebrewSvg }] = await Promise.all([
    import("@excalidraw/excalidraw"),
    import("../ui/canvasExport"),
    import("../canvas/noteCards"),
    import("../canvas/exportFix"),
  ]);
  const contents = await cardContents(scene.elements as never, read);
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/excalidraw/fonts/Assistant/Assistant-`;
  const font = async (bold: boolean) => {
    try {
      const blob = await (await fetch(`${base}${bold ? "Bold" : "Regular"}.woff2`)).blob();
      return await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).replace(/^data:[^;,]*/, "data:font/woff2"));
        r.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };
  const slides: SlideView[] = [];
  const urls: string[] = [];
  for (const f of frames) {
    const hidden = new Set(f.noteElementIds);
    const elements = cardsForExport(scene.elements.filter((e) => !hidden.has(e.id) && !e.isDeleted) as never, (p) => contents.get(p) ?? null);
    const frame = elements.find((e) => e.id === f.frameId);
    const svg = await exportToSvg({ elements: elements as never, appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false, frameRendering: { enabled: true, name: false, outline: false, clip: true } } as never, files: scene.files as never, exportPadding: 0, exportingFrame: frame as never });
    await fixHebrewSvg(svg, font);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", f.title);
    const markup = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    urls.push(url);
    slides.push({ title: f.title, notes: f.notes, dir: f.dir, content: createElement("img", { src: url, alt: f.title, style: { inlineSize: "100%", blockSize: "100%", objectFit: "contain" } }) });
  }
  show(title, frames[0].dir, slides, 0, urls);
  return slides.length;
}
