/**
 * A rendered chapter's text as one string, and DOM ranges ↔ offsets in it
 * (plan W1.14). The text is the concatenation of the chapter's text nodes in
 * document order — the same string highlights are anchored in, so a
 * highlight's TextPositionSelector and the quote's context refer to it.
 */

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export function chapterText(root: Node): string {
  return textNodes(root).map((t) => t.data).join("");
}

/** Offsets of `range` in chapterText(root), or null when it lies outside `root` or is empty. */
export function rangeToOffsets(root: Node, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const doc = root.ownerDocument ?? (root as Document);
  const before = doc.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  // Range.toString() concatenates the same text nodes chapterText() does.
  const start = before.toString().length;
  const end = start + range.toString().length;
  return end > start ? { start, end } : null;
}

/** Wrap chapterText(root)[start, end) in <mark> elements (one per text node it crosses). → the marks. */
export function markOffsets(root: Node, start: number, end: number, attrs: Record<string, string>): HTMLElement[] {
  const marks: HTMLElement[] = [];
  let pos = 0;
  const doc = root.ownerDocument ?? (root as Document);
  for (const t of textNodes(root)) {
    const a = pos;
    const b = pos + t.data.length;
    pos = b;
    if (b <= start || a >= end) continue;
    const from = Math.max(start, a) - a;
    const to = Math.min(end, b) - a;
    let target = t;
    if (from > 0) target = target.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);
    const mark = doc.createElement("mark");
    for (const [k, v] of Object.entries(attrs)) mark.setAttribute(k, v);
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}
