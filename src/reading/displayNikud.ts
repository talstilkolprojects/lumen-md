/**
 * "Show niqqud" (plan W5.6): vowel points drawn on the rendered preview for
 * reading, never written to the note. The pointed text replaces the text
 * of the preview's DOM nodes only; the note in the store, the editor and
 * the file on disk are never touched (src/__tests__/displayNikud.test.ts
 * checks the bytes). Turning it off puts every node's own text back.
 *
 * Only read-only rendered text is pointed: never an editable surface (the
 * WYSIWYG editor is `.prose-lumen` too, and pointing it would change the
 * note), never code, keyboard keys, math or anything marked
 * `data-no-nikud`. A pointed result is used only when it is the same text
 * with marks added (removing the marks gives back the original exactly), so
 * a model mistake can never change a letter on screen. Text that already
 * carries niqqud (the author's) is left as written.
 *
 * The model call is a seam (`point`): src/ui/ReadingAids.tsx passes the
 * on-device Nakdimon service (plan 6.3), which asks before downloading.
 */
import { removeNikud } from "../text/nikud";

/** Batch pointer: the same number of strings back, each the input with marks added. */
export type PointMany = (texts: string[]) => Promise<string[]>;

const HEBREW = /[א-ת]/;
const SKIP = "code, pre, kbd, samp, script, style, textarea, input, math, svg, .katex, [data-no-nikud], [contenteditable]:not([contenteditable='false'])";

/** The node's own text before it was pointed, for every node this module changed. */
const originals = new WeakMap<Text, string>();
/** The nodes changed under each root, to restore them. */
const touched = new WeakMap<Element, Set<Text>>();
/** Pointed text by source text: re-rendering the same paragraph costs no model call. */
const cache = new Map<string, string>();
const CACHE_MAX = 5000;

/** Is `pointed` exactly `source` with niqqud marks added? */
export function isSamePointed(source: string, pointed: string): boolean {
  return removeNikud(pointed) === removeNikud(source) && pointed.length >= source.length;
}

/** May this text node be pointed? Hebrew, read-only, not code. */
function eligible(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || !HEBREW.test(node.data)) return false;
  if (parent.closest(SKIP)) return false;
  // why: an editable ancestor means this text is the note itself
  return !parent.isContentEditable;
}

/** Hebrew text nodes under `root` that may be pointed (and are not pointed yet). */
export function collectTextNodes(root: Element): Text[] {
  const out: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const o = originals.get(t);
    // why: already showing our niqqud (React kept the node and its text)
    if (o !== undefined && t.data !== o && removeNikud(t.data) === removeNikud(o)) continue;
    if (o !== undefined) originals.delete(t);
    // why: text the author pointed keeps the author's niqqud
    if (removeNikud(t.data) !== t.data) continue;
    if (eligible(t)) out.push(t);
  }
  return out;
}

function remember(source: string, pointed: string): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(source, pointed);
}

/**
 * Point every eligible Hebrew text node under `root`. Returns how many
 * nodes now show niqqud. `signal` stops it between batches; the nodes done
 * so far stay pointed until `clearDisplayNikud`.
 */
export async function applyDisplayNikud(root: Element, point: PointMany, signal?: AbortSignal): Promise<number> {
  const nodes = collectTextNodes(root);
  if (!nodes.length) return 0;
  const sources = nodes.map((n) => n.data);
  const missing = [...new Set(sources.filter((s) => !cache.has(s)))];
  const BATCH = 64;
  for (let i = 0; i < missing.length; i += BATCH) {
    if (signal?.aborted) break;
    const part = missing.slice(i, i + BATCH);
    const out = await point(part);
    part.forEach((s, j) => {
      const p = out[j];
      // why: a result that is not the same letters (or no result) leaves the text as written
      remember(s, typeof p === "string" && isSamePointed(s, p) ? p : s);
    });
  }
  let set = touched.get(root);
  if (!set) touched.set(root, (set = new Set()));
  let shown = 0;
  nodes.forEach((n, i) => {
    const pointed = cache.get(sources[i]);
    // why: the node may have been re-rendered while the model worked; then it is pointed on the next pass
    if (pointed === undefined || n.data !== sources[i] || !n.isConnected) return;
    if (pointed !== n.data) {
      originals.set(n, n.data);
      set.add(n);
      n.data = pointed;
    }
    shown++;
  });
  return shown;
}

/** Put back the text of every node under `root` this module pointed. */
export function clearDisplayNikud(root: Element): void {
  const set = touched.get(root);
  if (!set) return;
  for (const n of set) {
    const o = originals.get(n);
    if (o !== undefined && removeNikud(n.data) === removeNikud(o)) n.data = o;
    originals.delete(n);
  }
  set.clear();
}

/** Tests. */
export function __resetDisplayNikud(): void {
  cache.clear();
}

/** The rendered preview roots: `.prose-lumen` that is not an editor. */
export function previewRoots(doc: Document = document): Element[] {
  return [...doc.querySelectorAll(".prose-lumen")].filter((el) => !(el as HTMLElement).isContentEditable && !el.closest("[contenteditable]:not([contenteditable='false'])"));
}

/**
 * Keep the preview pointed while it re-renders (typing in split view, a new
 * note): a debounced observer points what changed. `stop()` disconnects it
 * and restores every root's own text.
 */
export function watchDisplayNikud(point: PointMany, opts: { doc?: Document; delayMs?: number; onError?: (e: unknown) => void } = {}): { stop: () => void; ready: Promise<void> } {
  const doc = opts.doc ?? document;
  const controller = new AbortController();
  const seen = new Set<Element>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  const pass = async () => {
    for (const root of previewRoots(doc)) {
      if (controller.signal.aborted) return;
      seen.add(root);
      observer.disconnect();
      try {
        await applyDisplayNikud(root, point, controller.signal);
      } finally {
        if (!controller.signal.aborted) observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
      }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      running = running.then(pass).catch((e) => opts.onError?.(e));
    }, opts.delayMs ?? 250);
  };
  const observer = new MutationObserver(schedule);
  running = pass().catch((e) => {
    opts.onError?.(e);
  });
  return {
    ready: running,
    stop: () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      observer.disconnect();
      for (const r of seen) clearDisplayNikud(r);
      for (const r of previewRoots(doc)) clearDisplayNikud(r);
    },
  };
}
